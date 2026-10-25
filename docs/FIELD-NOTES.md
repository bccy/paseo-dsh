# 实战缺陷记录

这份文件是开发过程中**真实发生过**的问题清单，按发现顺序排列。每一条都写清了
症状、根因和修法。

它比 [ADOPTION.md](./ADOPTION.md) 更啰嗦——ADOPTION 把教训按主题归纳，这里保留
时间顺序和当时的错误判断。**如果你正在接自己的运行时，这份清单可以当检查表用。**

条目按发现顺序编号，并按发现它的那轮工作分段（基础契约 → 协议错配 → 能力声明 →
专项审计 → 会话恢复 → … → 客户端渲染 → 协议边界与子代理生命周期）。编号里的
`b`/`c`（29b、39b…）是同一症状的后续补记，不另起一个数字。

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

### 28. `read_image` 的图片：从"看不见"到"看得见"再到"转圈后失败"

**第一段（看不见）**：DSH 的 `read_image` 返回的是**附件引用**
（`{path, image:{attachmentId, mediaType, ...}}`），不是内联图片数据；而 Paseo 的工具详情
联合类型里没有图片变体（`shell/read/edit/write/search/fetch/worktree_setup/sub_agent/
plain_text/plan/unknown`）。插件渲染器只能拿到文本，`timeline.ts` 的 `textOf` 也只抽
text 块。所以工具行里直接画图需要 Paseo 侧新增图片型 tool detail，或允许插件时间线行
携带附件——本仓库不改全局包。

**第二段（看得见，但只做了一半）**：`3c3941f` 之后，桥给每个图片块**追加** `hostPath`
（`dsh-bridge/lib/image-host-path.js`），插件为它多发一条文本是
`![name](file:///绝对路径)` 的 `assistant_message`——这是 Paseo 唯一会去取字节的形状。
当时的验收是"解码后文件存在"，**断言打在路径存在，没打在宿主能把它读成图片**。

**第三段（转圈后失败）**：宿主按**扩展名**判图片，从不嗅探 magic bytes
（`IMAGE_MIME_TYPES` 的键是 `.png/.jpg/.jpeg/.gif/.webp/.svg`，其余二进制落到
`kind:"binary"`）。而 DSH 的附件存储是内容寻址、**只写摘要、没有扩展名**：
`<DSH_HOME>/attachments/v1/objects/<xx>/<sha256>`。于是 JPEG 被判成 `binary`，前端
`if ("image" !== kind) throw` → 界面**先 loading 再报"图片预览不可用"**（字节真的传了
189KB 才被拒）。所以原文那句"只能通过文件预览查看"变成了**更糟**的状态：看着像渲染
bug，其实是命名 bug。

**修法**：`hostImagePath(hostPath, mediaType)`——官方路径**带扩展名就原样用**（零复制；
将来 DSH 自己命名后这个 shim 自动退场）；只有没有扩展名时才把字节复制到
`<tmp>/paseo-dsh-attachments/<sha256><ext>` 并指向副本。扩展名**只从 `mediaType` 推**：
DSH 入库时会重编码，`name` 可能是 `tool-rows.png` 而实际是 `image/jpeg`，按 name 会写错。
副本名**确定性**，因为插件重放靠它去重（随机名会在每次重开时多出一行）。复制失败一律
回退到官方路径——最坏情况不比没有这个 shim 更差。

**验证方式（这次的教训）**：不要断言"文件存在"，要断言**宿主能把它读成图片**。同一份
字节、只差一个后缀，判定就翻转——这条用 `/tmp` 下同名不同后缀的两个副本即可当场复现。
`harness/image-host-path-check.mjs`（31 条：物化副本且字节一致、mediaType 压过 name、
官方带后缀不复制、源文件消失/未知 mediaType 回退）与 `harness/image-check.cjs`（插件侧
8 条）覆盖。

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
`harness/timeline-check.cjs` 19/19（工具生命周期、重复调用、中断收尾、回放）；
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
Paseo 这边却是 `命令 pwd; ls -d ~/.dsh 2>/dev/null && ...` 一长串原始命令。

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

DSH 原版那行还有 `● <执行者>` 和"复制"按钮，我们没有跟进——那是它的宿主 chrome，
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
- 子会话 `open()` 带上 `persistence: {version:1, data:{sessionId:<nativeId>}}`。**但要说清：Paseo
  0.11.2 的 daemon 只对 `restoration:"core"` 的会话保留这个句柄**（`plugin-provider.js`：
  `this.persistence = this.restoration === "core" ? (event.persistence ?? null) : null`），子会话是
  `restoration:"parent"`，句柄在宿主侧被直接丢弃 —— 所以「子会话可被归档」在**当前宿主版本上并不会
  真正发生**，这一条是为将来版本预留的。子会话的归档目前只能由根会话的归档连带覆盖。
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

#### 39c. 归档判定要照抄 DSH 的血缘规则，不能只看集合成员

`archivedSessionIds` 里只记**被点名的** id，但 DSH 判定"这个会话是否处于归档之下"用的是
session controller 的 `underArchivedSession`：沿 `origin:"subagent"` + `parentSession` 的血缘
往上走，**任一祖先被归档就算**（fork 不继承；环路只访问一次）。也就是说归档一个根会话，
它整棵子代理树在 gate 看来都已归档，而集合里只有根那一个 id。

桥原先在两处都做**精确匹配** `archived.has(id)`，和这个语义不一致：

- `paseo/subagents` 的 `archived` 标记 → 归档根之后，子会话仍被当作未归档，重放会把它们
  重新播报（正是"归档后又复活"的一半原因）；
- `listSessions` 的导入过滤 → 归档根之后，它的子会话仍出现在 Paseo 的导入列表里。

**修法**：把规则抽成不依赖 DSH 包的纯模块 `dsh-bridge/lib/archived-lineage.js`
（`underArchivedSession(headers, archivedIds, sessionId)`，逐字移植），桥再补两个私有 helper
——`#archivedSessionIds()`（registry 读不到时给空集，保持"不过滤"的旧语义）与
`#sessionHeaders()`（先读 `sessionPersistence.list()`，再叠上 live `sessions.list()`，因为
子会话的祖先通常已经不 live，只有落盘 header 才走得上去）。`listSessions` 和
`paseo/subagents` 都改用它。

**同时留个记录**：Paseo 客户端目前**不会**对 provider 子代理发归档请求。它的
`createArchiveFinishedSubagents` 把行分成两类——`kind:"paseo"`（真 agent，走
`archiveAgent` → provider 原生归档）和 `kind:"provider"`（provider 子会话，走
`useProviderSubagentStore.hideFromTrack(...)`，**只写客户端内存 Set，没有持久化、也不发请求**）。
opencode 的 Task 子代理和 DSH 的原生子代理都属于后者（0.11.2 与 0.11.4 代码相同）。所以插件
这一侧是"能力已备、入口未接"：Paseo 一旦补上 dismiss/archive 请求（或把 `hiddenFromTrack`
持久化），`session.archive`/`unarchive` + persistence 句柄就能直接生效。

**验证**：新增 `harness/archived-lineage-check.mjs` **12/12**（自身/父/祖父归档、无关 id、
fork 不继承、环路终止、未知 header、Set/数组、空集）；真机 `dsh --profile paseo` 上对
`6d0a20ce` 做往返——归档根前两个子会话 `archived=false`，归档根后变 `archived=true`，
取消归档后回到 `false`，且 `workspace.json` 不留副作用；`subagent-check.cjs` **48/48**、
`archive-registry-check.mjs` 2/2、`tsc --noEmit` 干净；内嵌桥（6 个文件）已重生成。

---

## 第十三轮：协议边界与子代理生命周期

### 40. 写在 `detail` 上的额外字段会被协议静默剥掉 —— 只有 item 级 `metadata` 能过插件边界

**症状**：结构化行全部退回纯文本 —— read 没有行号、edit 没有真 hunk diff、grep 没有分组、
web 卡没有引用列表。真机上如此，而**本地离线断言全绿**。

**根因**：插件子进程的出口会给每个事件跑一次 `ProviderEventSchema.parse(...)`，而
`toolCallDetailSchema` 的**每个成员都是 `.strip()`**（`@getpaseo/plugin` 的
`dist/server/provider.js:485` 起，包括最后的 `unknown` 成员）。`.strip()` 的语义是"schema
没点名的键直接删掉，不报错" —— 所以挂在 `detail` 上的 `meta` 在过边界时无声消失。item 级
`metadata` 是 `jsonObjectSchema.optional()`，原样过去。

**复现**（一行 node 命令，用仓库 `paseo-plugin/node_modules` 里那份包）：

```bash
cd paseo-plugin
node -e 'const {ProviderEventSchema}=require("@getpaseo/plugin/server/provider");
  const item={id:"i",type:"tool_call",callId:"c",name:"read",status:"completed",error:null,
    detail:{type:"read",filePath:"/a",content:"x",meta:{probe:1}},
    metadata:{locale:"zh-CN",presentationMeta:{lines:[{number:1,text:"a"}]}}};
  const p=ProviderEventSchema.parse({type:"timeline.item",sessionId:"s",item});
  console.log("detail keys", JSON.stringify(Object.keys(p.item.detail)));
  console.log("metadata", JSON.stringify(p.item.metadata));'
# detail keys ["type","filePath","content"]                                         ← meta 没了
# metadata {"locale":"zh-CN","presentationMeta":{"lines":[{"number":1,"text":"a"}]}} ← 原样保留
```

**后果**：我们曾把 DSH 的 `data.meta` 挂在 `detail.meta`，于是行号 / 真 hunk diff / grep
分组 / web sources **在真机上全部到不了客户端**；而离线断言是绿的，因为断言直接调用
`toolCallData(...)` 并把 detail 传进去，**根本没经过 `ProviderEventSchema.parse`**。这正是
它危险的地方：断言打在了错误的层上 —— 测试通过只证明"函数能读到我给的字段"，不证明
"这个字段能活着走到函数面前"。

**正确做法**：

- 数据走 **item 级 `metadata.presentationMeta`**（与既有的 `metadata.description`、
  `metadata.locale` 合并），detail 只放协议点名的字段。
- **断言要打在协议层**：真跑一遍 `ProviderEventSchema.parse`，断言字段在 parse **之后**
  仍在；同时**反向断言** detail 上的额外字段确实被剥掉（否则将来有人"顺手放回 detail"
  会一路绿到真机）。

**验证**：`harness/timeline-check.cjs` 的 "the meta survives the plugin's own event schema"
一段就是这套双向断言 —— 正向断言 `presentationMeta.lines[0].text` / `lang` / `locale` 过
parse 仍在，反向断言 `!("meta" in parsed.item.detail)`，并额外构造一个把 meta 挂回 detail
的 item，断言它确实被剥掉。

**一句话教训**：**离线断言过了不等于过得了协议边界。** 两个独立代理给出相反结论时
（一个说"字段在"、一个说"字段没了"），不用继续争论，跑一次复现命令就能定案。

### 41. 被中断的子代理永远显示「运行中」（修复中）

**症状**：被中断的子代理在 Paseo 里那一行永远 running、一直脉冲；重载插件也没用。

**根因**：子会话日志的**末事件是 `step/start`、没有 `turn/end`**（实证：某个被中断的子代理）。
`replaySubagents()` 重放这个日志后，只有 `turn/end` 能恢复终态，于是那一行永远 running。
Paseo 对子会话 attach 时的默认状态就是 running，而它的宿主只消费**终态**的 `session.turn`；
DSH 又不会为"这个进程已经死了"落任何事实，所以**光看日志形状分不出"还活着"和"被中断了"**
—— 一个活着的 agent 在两步之间写下的尾巴同样是 `step/start`。唯一能区分的是 live 通道。

**修法（进行中）**：重放时用 live 证据门控（桥在本进程播报过这个 child、或
`#observedLive` 为真）；拿不到 live 证据、own suffix 里又没有终态的，收成 `canceled`
（Paseo 自己的适配器给"被打断的回合"的就是这个状态），而不是留在 running。

**状态**：**修复中**。`session.ts` 的 `replay()` 已按上述决定改，连同 `timeline.ts`、
假桥、`subagent-check.cjs`、`timeline-check.cjs` 的用例，都在同一批**未提交**的工作区改动里；
本文写作时尚未提交，真机行为以提交后的版本为准。

### 42. `cancel_agent` 返回 `success:false`（已结案：时序，不是缺陷）

**症状**：在一个正在跑数数的 agent 上调 `cancel_agent`，返回失败（`success:false`），
而那个 agent **照样跑完**。

**结论**：**时序** —— 取消落到时那一回合已经收尾了。`{success:false}` 在 Paseo 侧只有一条
来源：`agent-manager.js` 的 `hasInFlightRun(agentId)` 为假 → `lifecycle-command.js`
提前返回 `{cancelled:false, cancellation:{status:"not_running"}}` → MCP 翻成
`{success:false}`。该分支只有 `logger.trace`，默认 info 级别**不留任何日志**，所以现场什么
都不打印。

另有一条路能产出"被拒绝"的形状，但**不是**这个：provider 回 `request.failed` 时，
`interruptSession` 会打 **ERROR** `Failed to interrupt session`，等 rescue 超时后抛
`AgentRunCancellationError` → MCP 返回 **tool error**，不会是 `{success:false}`。本机四份
daemon 日志里 `Failed to interrupt session` 计数为 **0**。

三次真机实验（一次性靶子，全部已归档）：

| 靶子 | 场景 | 返回 | DSH 会话日志的 `turn/end` | 实际 |
|---|---|---|---|---|
| A | 数到 500，在它收尾瞬间取消 | `{"success":false}` | `reason {"kind":"completed"}`（**自己跑完**） | 不是被忽略，是已经结束 |
| B | 根代理 `sleep 30` 中取消 | `{"success":true}` | `{"kind":"aborted","reason":{"kind":"user"}}` | 只跑了 step1 |
| C | 子代理 `sleep 30` 中取消 | `{"success":true}` | `aborted/user` | 只跑了 step1 |

**教训**：Paseo 的 `cancel_agent` 对"回合已经结束"和"拒绝取消"返回**同一个**
`{success:false}`。要分清两者，唯一可靠的证据是 DSH 会话日志里那一回合的 `turn/end`
reason —— 先看它，再决定往哪查。另外：**我们本来就实现了 `session.interrupt`**
（`provider.ts` 的 `case "session.interrupt"`），不是漏实现。

### 43. 被取消的根回合被上报成 `completed`（已修）

**症状**：点"停止"之后，界面显示这一回合**正常完成**，而不是被取消。

**根因**：根回合的终态只在 `session.ts` 的 `#onStatus` 里以**硬编码的 `"completed"`** 发出；
`aborted → canceled` 的映射（`childTurnState`）只用在子会话上。而 Paseo 自己的 opencode /
claude / codex 三个适配器在中断时**全部**上报 `turn_canceled`，协议侧
（`plugin-provider.js` 把 `session.turn state:"canceled"` 翻成 `turn_canceled`）消费的也正是
这个值。于是"用户按了停止"在界面上变成"一切正常"。

**修法**：记住 DSH `turn/end` 的 reason（新字段 `#turnEndState`），`aborted → canceled`，
**其余 reason 一律保持原行为**（控制爆炸半径：以 `error` / `max-tokens` / `blocked` /
`interrupted` 结束的回合仍报 `completed`，那是另一件事，这次没动）。

**验证**：`harness/steer-check.cjs` 新增 `cancel` 模式的假桥驱动，断言回执是
`request.completed` 且带 requestId、真的发了 `session/cancel`、取消后该回合不再有任何输出、
终态是 `canceled` 且 turnId 一致、同会话还能跑下一回合、**全程无 `shutdown` 帧**（＝不是杀
进程）。负向验证两条：把 `provider.ts` 改成"只回执不停"→ 20/24 失败；把 `session.ts` 退回恒
`completed` → 恰好命中那一条断言，23/24 失败。真机 `dsh --profile paseo` 端到端探针：回执
`request.completed`、终态 `canceled`、只有 step1 的 `sleep 45` 被起过。

**仍未修（见下节）**：DSH 原生子代理**无法取消** —— `DshChildSession.interrupt()` 抛
`subagent sessions are read-only`，桥的 `session/cancel` 也只认 Paseo 根会话。DSH 本身支持
（`dsh-subagent` 的 archive-admission 就是 `child.cancel({kind:"parent"})`），修它必须改
`dsh-bridge/`（要重生成内嵌桥）。目前从 Paseo 侧也够不着：provider 子代理不是 agent，
UI 只有 `provider_subagents.list/.timeline.get/.update`，没有停止入口。

### 44. 一次压缩在界面上变成两/三行 —— 宿主按 loading 行原地合并（已修）

**症状**：在 App 里手动发一次 `/compact`，时间线上出现**不止一行**压缩标记。查会话日志：
`compaction/start` 只有**一条**（带 `sourceCommandId`），DSH 确实只压缩了一次。

**第一次修（`f241ac3`）方向错了。** 当时的判断是"provider 行是只追加的、`loading` 在插件
通道上做不到"，于是把三条事件压成**一条 completed**。这确实去掉了重复，但也把
Paseo+opencode 那种「正在压缩…」的体验一并去掉了。

**真正的宿主行为（反编译证据，不是推断）。** 从宿主 web bundle
（`@getpaseo/server/dist/server/web-ui/_expo/static/js/web/index-*.js`）里挖出的压缩归并
函数：

```js
function ne(e, t, n, s) {
  if ("completed" === t.status) {
    const n = e.findIndex(e => "compaction" === e.kind && "loading" === e.status);
    const i = n >= 0 ? e[n] : void 0;
    if (n >= 0 && i && "compaction" === i.kind) {
      const o = Object.assign({}, i, s ? { timelineCursor: s } : {},
        { status: "completed", trigger: t.trigger ?? i.trigger, preTokens: t.preTokens ?? i.preTokens });
      return [...e.slice(0, n), o, ...e.slice(n + 1)];   // ← 原地改在 loading 那一行上
    }
    if (n >= 0) return e;
  }
  // 找不到 loading 行 → 追加一条新行
  const i = Object.assign({ kind: "compaction", id: u(e, "compaction", t.status, n) }, ...,
    { timestamp: n, status: t.status, trigger: t.trigger, preTokens: t.preTokens });
  return [...e, i];
}
```

**关键结论**：
- 收到 `completed` 时，宿主**全表查找第一条 `kind === "compaction" && status === "loading"`**
  的行并**原地合并** —— **不是按 id，也不是按相邻**；
- **只有找不到 loading 行时才追加新行**。

所以 `loading` + **一条** `completed` = **一行**，并且会从「正在压缩上下文」翻成
「上下文已手动压缩」。而当时发了两条 `completed`（summary 一条、end 一条）→ 第一条合并进
loading，第二条找不到 loading 行 → **追加** → 用户看到的两行（活动流里三条还含原始事件）。

**修法**：`compaction/start` 发 `loading`；`compaction/summary` 发**一条** `completed` 并记下
id；`compaction/end` 对该 id 已发过 summary 就丢弃（同时 `delete()`，保证同一份日志重放两遍
一致），没发过就补发（覆盖失败收尾与日志停在 summary 之前两种情形）。**绝不为同一个
`compactionId` 发第二条 `completed`。** 另外，被压缩接管的那条 `/compact` 命令行整条不发
（压缩标记就是它的行），关联用 DSH 自己的
`compaction.sourceCommandId === command.commandId`（真实样本两者都是 `cmd-e0bf8ecc-1`）；
`kind:"error"` 时照旧发 failed 行，因为 marker 承载不了失败。日志停在 `compaction/start`
（进程被杀）时，重放收尾把仍 loading 的行收成 completed 并打 warning
（`TimelineBuilder.settleLoadingCompactions`），否则那一行会永远 pulse。

**验证**：`harness/timeline-check.cjs` 的压缩段断言 —— 完整括号恰好 2 条（loading +
completed，同 id）、`completed` 条数恒为 1、只有 start+end / start+summary 也是 2 条、重放两遍
仍各 2 条、`/compact` 命令行 0 条、failed `/compact` 1 条 failed 行、settle 幂等。

---

### 45. `/compact · /compact` —— 行头的两半印了同一句话（已修）

**症状**（用户在 App 里截图报的）：发一次 `/compact`，行头读作 `/compact · /compact`，同一个
字符串出现两遍。

**根因**：行头是 `label · summary` 两半拼的。

- `label = toolLabel(item.name)`，而命令行 item 的 `name` 就是 `/${name}`；
- `summary = truncate(description === "" ? primary : description)`，命令行没有 `description`，
  于是 `summary = primary`；
- 而 `#commandDone` 把 `detail.label` 也设成了同一行 `/${name}` —— `primary` 与 `label` 同值。

同一类共三处，判据都是"两半说同一句话"：`todo_write`（`detail.label` = `UI.toolLabels.
updateTasks` = 工具名标签「更新任务清单」）和 `ask_user_question`（「提问」）走的是同一条路。

**修法**（三处）：

1. **服务端**：`#commandDone` 的 `detail.label` 改放**参数**（`command/run` 的 `data.args`，
   `trim()` 后）。行头的第一半已经是命令本身，参数才是屏幕上还没有的信息：`/compact` 没有
   参数 → 第二半为空；`/goal <目标>` → 显示目标。
2. **客户端** `plain_text` 分支去掉 `|| text` 回退：空 `label` 是一个**值**，不是"没有
   label"；旧回退把输出提升成 summary，同时让展开体丢掉那段输出。`label` 归 label、`text`
   归 body。
3. **客户端**在数据层做通用去重：`summary === label` 时置空。**放在 `tool-call-data.ts`
   而不是 `.tsx`** —— 本仓库的约定是纯函数才断言，React 组件刻意不断言。

**验证**：`harness/tool-call-check.cjs`（289 条全过）新增 —— 无参数命令行 `summary` 与
`headline` 均为空且输出仍在 `body`、带参数命令行 `summary` 就是那段参数、`todo_write` /
`ask_user_question` 的 `summary` 为空（用 `toolLabel()` 取值，不硬编码语言）。
`harness/timeline-check.cjs` 断言 `command/done` 的 `label` 是参数（空参数 → 空串、非字符串
`args` 退化成空串、`command/run` 缺失时仍用兜底标题且 label 为空），以及被压缩接管的
`/compact` 整条不发。

### 46. 展开的正文"太白"：非 diff 块一律用 muted 前景色（已改）

**症状**（用户报）：点开工具行，只有带 `+`/`-` 内联格式的 diff 块有颜色层次，**其余展开块
（命令 banner、命令输出、读取的代码、搜索命中、兜底代码面）通篇是全对比前景色**，在深色主题
下"太白"，和旁边的思考行、行头标题（都是 muted）不是一路。

**根因**：Phase 1 把每个数值收进 `client/tokens.ts` 时，正文色照抄了 DSH —— DSH 的
`.line` / `.readBody` / `.match` 确实是全对比前景色。但那是 DSH 自己的排版语境；本仓库的
思考行（`inline-thinking.tsx`）和行头标签用的是 `foregroundMuted`（第 30 条里"标签太白"
那次就是这个结论），两套并存就出现了"同一屏里有的字灰、有的字白"。

**修法**：只改 token 表，组件一行不动 —— 六个正文样式从 `colors.foreground` 换成
`colors.foregroundMuted`：

| 样式 | 覆盖的块 |
|---|---|
| `commandTextStyle` | 命令 banner 的命令行 |
| `outputTextStyle` | 命令输出 |
| `codeTextStyle` | 读取/搜索/兜底代码面（`headline` 与 `body` 共用） |
| `searchLineTextStyle` | 搜索命中的那一行 |
| `searchFilePathTextStyle` | 搜索分组的文件路径（保留 600 字重） |
| `readLineTextStyle` | 读取卡里的代码 |

**边界**：diff 块**不动** —— `+`/`-` 行仍按 `diffTextColor` 上语义色（成功/危险），上下文
行本来就是 muted；这是用户唯一明确要保留的"内联格式"。web 块也没动：URL 与来源标题是
`accent` 链接色，正文本来就是 muted。

**验证**：`harness/style-check.cjs` 240/240（四条旧断言从 `foreground` 改成
`foregroundMuted`，新增 `codeTextStyle` 与 `readLineTextStyle` 两条，diff 的语义色断言原样
保留）；`npx tsc --noEmit` 干净；`harness/tool-call-check.cjs` 289/289（tokens 参与编译）。
这是**有意偏离 DSH**，与第 30 条"标签用 muted"同源，已记进
`docs/RENDER-PLAN.md` 的「刻意的偏离」。

---

### 47. 侧边「变更」面板卡死 —— 生成文件的单行长度变成下游的平方级成本（已修）

**症状**（用户报）：在 Paseo 里点侧边的「变更」面板会**卡死**，别的项目不会，"只要有几行代码
变动"就触发。我把工作区改动全部撤销后面板立刻恢复（显示"没有可显示的变更"）——这个对照
本身就把范围缩小到了"改动的内容"，而不是"仓库或环境"。

**根因**：不在仓库大小，也不在改动行数，而在**最长的那一对改动行**。仓库其实很小（受控 95 个
文件 / 2.0 MB，`git status` 4 毫秒，`node_modules` 被正确忽略）。问题是
`paseo-plugin/server/bridge-assets.ts` —— 桥的 base64 内嵌副本 —— 生成时**一个文件一行**，
第 16 行是 **77,318 字符**；全仓库第二长的行只有 2,988 字符（差 26 倍）。

diff 只能按行告诉你"这一行被删了、那一行被加了"，要说清**这一行里哪几个字变了**，就得再做一遍
字符级对齐；而"两个序列的最佳对齐"要一张 `(m+1)×(n+1)` 的表：

```
77,318² = 5.98e9 格 ≈ 22.3 GB（仅 DP 表，按 4 字节/格）
```

base64 还有雪崩性质：源文件中间改一个字节，它后面所有字符全变。于是"改一行代码"= "整条 7.7 万
字符的行重写"。三次相关提交的 diff 形状一模一样：**13～16 行 diff，其中一行 75,895～77,319
字符**。行数很少，长度是灾难 —— 这就是"几行变动就卡死"。

**修法**：让生成文件不再有长行。

1. `paseo-plugin/scripts/generate-bridge-assets.mjs` 把 base64 按 **76 字符**分块、拼成多行
   字符串字面量（PEM 体那种写法）。最长行 77,318 → **84 字符**，行内对齐的表格从 59.8 亿格
   降到 7,056 格（约 85 万倍）。代价是这个文件的 diff 从 1 行变成约 1,600 行 —— 但每行都短，
   处理量是线性的。
2. 新增 `.gitattributes`，对该文件标 `-diff`：向 git 要 diff 的查看器会直接得到
   "binary files differ"。实测过渡期最重的场景（删掉旧的 77K 行）diff 只有 3 行、最长 101 字符。

**教训**：仓库大小、文件数、改动行数都不是"diff 会不会卡"的指标，**最长的那一对改动行才是**。
生成文件尤其容易踩 —— `bridge-assets.ts` 一度"只有 22 行"，看着极其无害。base64 不换行不只是
审美问题：任何做行内对比、行内高亮、语法分析的下游工具都会被它拖死（PEM 固定 64 字符一行，
历史原因之一就是这个）。

**验证**：`harness/bridge-assets-check.mjs` 新增一条"没有一行长到让 diff 变成平方级"的断言
（现 2/2），并把"漂移归因"的解析改成能读分块拼接；真值校验走**插件自己的运行时**（`require`
编译产物再 base64 解码），而不是另写一遍解析 —— 7 个桥文件与 `dsh-bridge/` **逐字节一致**；
`npx tsc --noEmit` 干净；16 个离线/插件层脚本全绿；用户实机确认面板"秒开"。

---

## 第十四轮：撤回——表面替换的正确写法、v4 日志格式与刷新旁路

这一轮把「撤回（rewind）」从方案 A（复用 `dsh-rewind-plugin`）改成自研，并在真实
`dsh --profile paseo` 上跑通端到端。**离线断言全绿、真实 append 必挂**在这里发生了两次，
值得逐条记下。

### 46. `assistant/message` + replace 是死路：DSH 的 replace 校验与消息类型契约互斥

**症状**：撤回请求成功返回 `kind:"success"`，但会话日志里没有任何替换事件，模型上下文也
没有变化；真实桥进程里错误被 `request.failed` 吞成一句失败。

**根因**：DSH rc.2 的 `session.append(...)` 对 replace 调用
`assertSourceEventReferences(event, shadowedSeqs)`，要求 `sourceEventSeqs` **覆盖每一个被
遮蔽的 surface 节点**；而 `assistant/message` 被契约禁止携带 `sourceEventSeqs`
（"embeds its source stream"）。两者互斥，只要区间非空必抛。

**修法**：占位事件换成可携带 `sourceEventSeqs` 的类型（`user`/`system`/`developer`），
并显式传 `sourceEventSeqs: [...shadowed]`。区间两端必须是**当前 `surface.nodes` 的 seq**，
不能用日志 seq；`endSeq` 取可见面尾部。

**教训**：`session.append` 在写前校验，失败不会改日志，所以"回执成功"不代表事件真的写进去了。
断言必须打在**真实 DSH Session/log**上（`harness/revert-shape-probe.mjs`、`harness/rewind-e2e.mjs`），
mock 只能证明纯函数。

### 47. v4 日志格式：`system/message` 必须处于打开的 turn/step 内

第一版修法用空 `system/message` 当占位（`deriveEventMessage` 返回 null，不进模型上下文）。
真实跑起来后：

- 撤回回执成功，但 `paseo/history` 读回 **0 条事件**；
- 会话日志尾部确实多了一行 `system/message`，但整份日志被判定 **corrupt**
  （`session "…": stored log is corrupt: SessionFormatError: system/message does not match an
  open turn and step`）；
- 后果不是"少一行"，而是**重开会话时历史全部丢失**。

**根因**：会话日志 v4 编解码器（`@deepseek-ai/dsh-session-format-v3-to-v4`）的状态机要求
`system/message`、`developer/message`、`assistant/message` 必须匹配当前打开的 turn/step；
撤回发生在 agent 空闲（`turn/end` 之后），没有打开的 turn，这条事件无法被合法编码。
`user/message` 没有这个约束。

**修法**：标记改用 `user/message` + **非 `user` 的 source kind**（本仓库用
`source.kind = "paseo-rewind"`）。非 user 源同时满足：不是撤回锚点、Paseo 重放跳过不显示、
记忆插件不采集。模型上下文会多一条 `(empty message)` 用户消息（与 `dsh-rewind-plugin`
同款取舍），实测无副作用。

**第二个坑**：标记 append 之后还要 `await ctx.get('sessions').flush(session)`。宿主的
时间线重建/重开会话紧跟在回执之后读日志，缓冲未落盘的标记会让重放仍带着被撤行
（"回执成功但界面没变"）。调试时 `history` 读回空、日志尾却没有标记，就是这个原因。

### 48. 重放折叠不能折 compaction：surface 是模型可见面，不是人类转写

第一版 `history()` 把所有 replace 都折叠。在真实会话上量化：8494 条事件 → 2447 条、
205 条用户消息 → 60 条。DSH 源码注释明确说模型可见面故意遮蔽被替换区间，
append-origin 事件才是人类转写的素材。

**修法**：只折叠本桥的撤回缝（按持久化的 `source.kind` 识别），遮蔽
`[startSeq, seamSeq-1]`（含尾随 `step/end`/`turn/end`）；compaction 的 replace 不折。
用真实会话日志副本做「重放保真」断言（`harness/replay-fidelity-probe.mjs`）。

### 49. 插件 provider 的 append-only history（上游 #4667）只能靠 Reload 旁路

Paseo 的 `plugin-provider` 把翻译后的事件推进一个只追加数组，`revert()` 只转发、不动它；
撤回后宿主强制从该数组重建时间线，于是旧行复活。上游 issue #4667（open，p2），
修复 PR #4668 关闭未合并；0.11.4/0.12 beta 均未修，插件协议也没有"删行"事件。

可行方案：撤回成功后**先回 `request.completed`**，再延迟 ~500ms spawn
`paseo agent reload <agentId>`（等价用户点 Reload agent：关会话再带 persistence 重开，
桥重放折叠后的 history）。**不能 await**：daemon 撤回持有 pending run，reload 会取消在飞
回合，两者互相等待。agent id 用 daemon 注入的 `config.env.PASEO_AGENT_ID`。
再加「停放会话」（空闲 dsh 进程 TTL 30s、同 cwd/route 才复用）把冷启动 1.5–2.7s 省掉。

### 50. 用户消息行的令牌不要"先显示后补"

旧实现先发一条无 `revertToken` 的用户行，拿到 DSH `messageId` 后再用同一个 id 补发。
Paseo 的按钮是**按 agent 能力位**显示的，不按行过滤：两次发射之间的窗口里点击撤回，
宿主报 `No provider revert token for message …`。改成拿到 `messageId` 后只发一次。

### 51. 停放进程的三条底线

1. 只停放**空闲**会话（有回合在跑就 shutdown）；
2. 只用**相同 cwd + route** 复用（否则初始化过的旧 route 会被静默沿用）；
3. 停放期间把处理器换成静默集（游离帧不能发给已关闭的会话）；进程退出要从池中移除，
   TTL/上限兜底，provider 整体关闭时清池。

**验证**（本轮新增，改撤回/桥后必跑）：`harness/revert-check.mjs`、
`harness/surface-check.mjs`、`harness/file-snapshot-check.mjs`、
`harness/revert-shape-probe.mjs`（真实 DSH Session）、
`harness/replay-fidelity-probe.mjs <log>`（真实日志）、
`harness/rewind-e2e.mjs`（真 profile 3 回合端到端：回执/文件/history 折叠/无 command 行/
暗号测试）、`harness/parked-sessions-check.cjs`（编译后的插件，**已删**——停放池已随
reload 旁路移除，共享子进程的 hold/release 改由 `multi-session-check.mjs` 计数断言）。
真机验收要用**新会话**（能力位只对新会话生效）。

---

### 52. 时间线重建后「工作时长」归零 / 少一段：重放必须带原始时间

**症状**：撤回触发 reload 重建时间线后，之前所有消息的「Worked for」都变成 0；修好时间戳后，
首轮又从 5s 变成 2s。

**根因**：Paseo 客户端用 `deriveStreamTurnTiming` 按时间线行的时间戳算时长（回合最后一行 −
用户消息行）。provider 的 `timeline.item` 不带 `timestamp` 时，daemon 按**事件到达时间**盖章：
重建时所有历史行都盖成同一时刻 → 全部 0 秒。修法是重放时把 DSH 存储事件的 `time` 转成 ISO
返回（主/子会话、user/builder/settle 行全覆盖）。

首轮少 3 秒是另一层：live 的首次提交时刻早于 DSH 进程启动，而 DSH 日志里的 `user/message`
是启动完成后才写的，重放没有提交时刻可用。这是数据缺口，不是算法 bug；Paseo 没把提交时间
传给 provider，无法可靠还原。

### 53. 「撤到空」在 live 客户端刷不干净 → 第一条消息直接拒绝撤回

**症状**：把会话撤到只剩系统提示后，App 仍显示旧消息；再点旧消息报
`No provider revert token for message user:history:N`，重启 App 才看到刷新后的状态。

**根因**：空重建的新 epoch 里没有事件（或只有一条通知），而 Paseo 客户端只在收到
「epoch 不匹配 + seq 1」的时间线行时才重置 live 时间线（bundle 里
`drop_epoch && seq===1 → resetLiveTimeline`）；撤回成功后客户端紧跟着的 refetch 又与
reload 竞争，事件可能在基线未就绪时被丢弃。

**走过的弯路**：先尝试在空重放时发一条 info 通知「会话已回退到起点」作为新 epoch 第一行。
daemon 层探针 PASS，但真机 App 仍可能因上述竞态不应用，且它只是把"刷新失败"包装成
"有提示"，不解决不确定的 live 刷新。

**最终决策**：撤回**当前可见对话的第一条消息**（含 compaction 后成为第一条的情况）在桥侧
直接拒绝，返回短提示「首条消息禁止撤回」——不写日志、不打断运行中回合、不触发 reload。
第一条之后的撤回完全不变。通知行补丁随之移除（空重建不再可达；历史遗留空会话重开就是
空对话）。Paseo 的撤回菜单按 provider 能力位渲染、不能按行隐藏（token 缺失只在点击时报错），
所以体验是"能点、点了被明确拒绝"；按行隐藏需要上游契约。

---
### 55. 撤回点击后没有反馈：用一条会随重建消失的临时通知

**现象**：点撤回后到旧行消失之间约 1 秒没有任何 UI 反馈（App 自带的按钮 pending 只覆盖
RPC 往返，覆盖不到 reload）。

**做法**：provider 在 `session.revert` **成功返回后、请求 reload 前**发一条 info 通知
「正在回退，请稍候」。它进的是旧时间线 epoch，重建后随旧行一起消失，所以只是临时状态，
不会留在历史里；首条被拒绝（桥侧直接抛错）不会走到这里，因此不会误报。
限制：若自动 reload 失败，这条通知会留下（旁边同时出现「时间线未自动刷新」提示）；
通知行不可更新，只能依赖 epoch 重建清理。

---
### 56. 审计收尾：reload 前的通知会被新 epoch 吞掉、history 失败不能伪装成空

**P1-1/P1-2 跨刷新通知**：撤回成功到 daemon 重建时间线之间约 1 秒。插件在 reload **之前**发出的
`session.notice`（文件恢复失败、自动刷新失败）属于旧 provider 会话；`reloadAgentSession` 会
丢弃已提交时间线并从新会话的 replay 重建，旧 epoch 的 notice 行随之消失——用户只看到文件
“没回来”或界面没刷新，却没有任何提示。修法：provider 维护
`providerSessionId → dshSessionId` 与按 dshSessionId 的延迟通知队列；新会话 `session.ready`
之后、daemon 采集 history 之前 flush，通知就成为新时间线的一行。文件失败通知改为显式延迟；
刷新失败按“旧会话还在就立即发，否则入队”。

**P1-3 history 读取失败**：`history()` 的 open 失败（非 NotFound）曾返回
`{available:true, events:[]}`，重开会话就是空白对话，只有 bridge stderr 有原因。改为
`unavailableHistory(error)`；插件侧同时发一条「会话历史读取失败」时间线警告。

**P1-4 撤回窗口的 prompt**：`session.revert` 成功后到 reload 关闭会话之间，prompt 会与
reload 竞争（被 cancel、丢失或追加到冻结区间之后）。provider 在撤回开始置
`#reverting`，该窗口内 prompt 直接以 `session.prompt_result failed` 拒绝并提示
「正在回退，请稍候」；reload 成功关闭会话、拒绝撤回、刷新失败、或 15s 兜底时释放。

---
### 57. 审计 P2/P3 收尾：文件层生命周期、agent 定位与死代码

- **rescue 覆盖**：同一路径第二次撤回时，rescue 文件名只按 counter 生成会被覆盖；改为
  `时间戳-counter-编码路径`，两次撤回各留一份。
- **objects 无回收**：prune/trim 只改 journal，内容对象永久残留。新增 `collectGarbage`：
  按当前 journal 的 backup 引用集删未引用对象；撤回的 prune/trim 后调用。
- **journal 并发**：并行编辑工具的 `appendFile` 与 prune/trim 重写可能交错，坏行会被读取端
  静默跳过。所有 journal 读改写进私有写队列 `#enqueue`（串行）。
- **chmod 失败语义**：内容已恢复但 chmod 失败时不再把路径报成 failed，只 warn。
- **agent 定位**：自动 reload 的兜底扫描从“原文包含 sessionId 即返回第一个”改为解析
  persistence/runtimeInfo 的 plugin handle、精确匹配 DSH session id；多个记录命中则放弃并记日志。
- **停放接管**：take 返回后进程可能在重接 handler 前退出 → 回退冷启动；接管后按目标 mode
  重置 plan（失败只记日志，不失败 open）。mcp-injection 的补丁生命周期断言也按停放语义更新：
  idle session.close 会停车，provider teardown 才删 patch（10/10）。
- **用户可见错误**：撤回令牌无效/消息不在可见面/范围不支持/撤回进行中改中文提示。
- **死代码/注释**：删未用导入、`pendingSkips`、`str_replace_editor`、`DshRevertResult` 的
  error 分支；修正孤儿 JSDoc、"500ms"、`dsh-rewind`、emit 等过时注释。

#### 57b. rescue 文件名再改：编码全路径会 ENAMETOOLONG（2026-10-20 全量审查补记）

**症状**：路径很深的文件在 `both` 撤回时恢复失败，文件保持已改、回执把该路径整体报
`failed`；rescue 目录里没有它的备份（而 rescue 正是手工重试的唯一材料）。

**根因**：上面第 57 条把 rescue 名改成 `时间戳-counter-编码全路径`。URI 编码后的绝对路径
在约 240 字符以上就超过 Linux/macOS 的 `NAME_MAX`（255 字节），`copyFile` 抛
`ENAMETOOLONG`，整个恢复随之失败。

**修法**（`dsh-bridge/lib/file-snapshots.js:538-566`）：名字改为
`<Date.now()>-<counter>-<sha256(路径) 前 16 位 hex>-<净化并截断到 64 字符的 basename>`。
长度有界、每路径可区分（sha256 前缀）、basename 仍可辨认；`counter` 继续保证同一路径的两次
撤回各留一份。只改 rescue 文件的**命名**：journal/objects 格式未动，旧版本写下的 journal
仍能原样恢复。

**验证**：`node harness/file-snapshot-check.mjs` 49/0，其中含“rescue 内容是恢复前内容”
（:103-106）与“两次撤回的 rescue 互不覆盖”（:312 起）两条用例；240+ 字符长路径本身未单独
构造实跑（本条为代码审查修正）。

#### 57c. 「DSH 没有 str_replace_editor」这个前提不成立（2026-10-20 全量审查补记）

第 57 条把 `str_replace_editor` 当死代码删掉，依据是“DSH 没有这个工具”。**前提是错的**：
`@deepseek-ai/dsh-tool-str-replace-editor@0.2.1-rc.2` 是一等公民包（base/web bundle 不默认
挂载，部署显式挂上就有；`dsh-workspace-changes` 也依赖它）。模型看到的工具名是
`str_replace_editor`，写命令 `create`/`str_replace`/`insert`，文件参数是 `path`（不是
`file_path`）。

**后果**：只撤 `write`/`edit` 时，一个只用该工具改过文件的会话做 `both` 撤回会**报成功却
不恢复文件**——正是本仓库最贵的那类“静默降级”。

**修法**（`dsh-bridge/lib/file-snapshots.js:57-78, 116-142`）：`TRACKED_TOOLS`（write/edit）
之外单独识别该工具；`mutationPathOf` 从 `path` 取路径且只认三个写命令，`view`/未知命令返回
`undefined`（不算写——把一次读记成“宣告该文件最新状态的编辑”，撤回会去重写一个根本没被改过
的文件）。`isTrackedTool` 只做名字级过滤，参数级判断在 `mutationPathOf`。

**验证/缺口**：`node harness/file-snapshot-check.mjs` 49/0，但只断言了 write/edit/read/bash
四例，**未覆盖 `str_replace_editor` 的三个写命令与 `view`/未知命令分支**（建议补 5 条：
tracked、三个写命令各取到 path、view → undefined、未知命令 → undefined、缺 path →
undefined）。本条为代码审查修正，离线检查待补。

---

### 58. 升到 DSH 0.2.1-rc 后每个回合都失败

**症状**：升级 DSH（`0.2.0-rc.2` → `0.2.1-rc.2`）后，所有回合直接失败；时间线上只有一条
空的 `[error]`，用量/重放都跟着空。界面看不出原因。

**根因**：`0.2.1` 收紧了 system-prompt 的模板变量——**只注册 `provider` 和 `model`**，
`{{cwd}}` 不再存在。而 bridge 的 `system-prompt.personaSuffix` 和 `preset-standard` 的人设里
都写了 `Your working directory is {{cwd}}.`，于是每个回合在提示词装配阶段就抛：
```
unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model
```

**修法**：删掉人设里的 `{{cwd}}`（`dsh-bridge/cordis.patch.yml` 与 profile 的 `preset-standard`）。
模型的工作目录由运行时上下文/工具侧提供，不靠这个变量。删掉后对 `0.2.0` 也无害（只是少一句
cwd 提示）。

**同一版本还有第二个坑**：`0.2.1` 的模型目录是**异步物化**的。Paseo 的 catalog 探测**故意不
`initialize`**（避免钉住路由），于是启动瞬间读到的 `models` 恒为 0 —— 表现是 **provider 可用、
但模型选择器里一个模型都没有**。修法：catalog 里先用 profile 默认路由做一次
`resolveCallConfig` warm-up，再对空结果做**有界重试**（~3s），等适配器注册完。

> **教训**：**升级上游运行时属于"重载之外的第二条隐藏路径"**。它不会改你的代码，却会因为
> 提示词变量、插件 schema、服务名、异步就绪时机这类"软契约"让功能静默失效。升版后必须重跑
> `plugin-check`，而不是只看 `doctor`（`doctor` 只查安装完整性，查不出回合层失败和空目录）。

### 59. 子代理编辑的文件不随父会话撤回 → 归并到根会话

**症状**：主会话 `both` 撤回成功（daemon 日志 `agent.rewind.start` / `agent.rewind.complete`
均为 `mode:"both"`；DSH 日志写入 `source.kind=paseo-rewind` 标记并遮蔽目标区间），但主会话
派子代理用 `write` 改的文件仍在工作区；回执 `files` 为空，父会话 journal 里没有该路径，
`~/.dsh/paseo-rewind/` 下也没有子会话目录。

**根因**（2026-10-19 真机取证）：`captureFileBeforeTool` 对 `header.origin==='subagent'`
（或 `delegationDepth>0`）直接 return；journal 按 sessionId 分目录，撤回只读父会话自己的
journal。子会话的编辑只在子会话日志里，父撤回寻址不到。实测证据：子会话 `9ef84cb2…` 的
DSH 日志里有一条 `write`，`file_path=<工作区根>/subagent-rewind-probe.txt`
（mtime 13:02:21.97）；13:02:39 撤回 `mode:"both"` 后文件仍在（内容 `SUBAGENT-EDITED-IN-WORKSPACE`），
父 journal 只有更早的两条无关记录。

**修法**：
- 新增纯模块 `dsh-bridge/lib/snapshot-owners.js`：`isDelegatedSession` + `rootSessionFor`
  （沿 `header.parentSession` 用 live `ctx.sessions` 上溯到非子会话；缺 `parentSession` /
  父不 live / 血缘成环 → 返回 undefined，fail-open）。
- `captureFileBeforeTool` 改为**先解析根会话**：锚 = 根会话当时最新人类消息 seq，快照写
  **根会话**的 journal/objects；新增 `sessionId:callId → owner` 内存映射，供 `commitFileTool` /
  `dropFileTool` 找回同一个 pending 键。路径按**工作目录服务**的当前目录解析（与
  `write`/`edit` 一致；`header.cwd` 只是会话最初的项目目录，不是执行时的目录）。
- 孙级逐层上溯；bash/外部进程/用户改动的边界不变。

**验收**：
- 新增 `harness/rewind-merge-check.mjs`（当时 31/31，第 60 条修后 37/37）：解析（子/孙/仅
  `delegationDepth` 都到根；缺链/死链/环 fail-open）、归属（子/孙编辑落根 journal、
  子会话无目录、相对路径按工作目录服务的当前目录）、失败/未跟踪不记录、双树隔离、
  `planRestore`/`restore` 覆盖子代理编辑。
- 既有离线回归：`file-snapshot-check` 41、`revert-check` 98、`surface-check` 18、
  `revert-shape-probe` 10，全部 PASS。
- 程序化真机探针（新 `dsh --profile paseo`，`paseo/revert both`）13/13：父会话
  `parent-control.txt` 与子代理 `subagent-test.txt` 均进根 journal（anchorSeq=25），
  子会话 `1294f547…` 无 journal；回执 `files.deleted` 同时列出两者，两文件均被删除。
- `rewind-e2e`（3 回合真机）12/12 PASS，既有文件回退与上下文撤回未回归。

**边界**：与 `dsh-rewind` / Claude Code checkpoint 的「子代理编辑不恢复」相反，是本项目的
有意扩展；上溯失败时退化为旧行为（不跟踪）。子会话自身仍不可撤回（只读投影）。

> **教训**：**"不可撤回"要先分清是语义边界还是实现缺口**。原先写进"已知限制"的理由
> （子会话没有父锚点、seq 不可比）只说明"不能直接复用子会话锚"，不说明"不能归并"——
> 按执行时的**根锚**把编辑记进**根 journal** 即可，代价只是一次 `sessions.get` 上溯。

### 60. 归并实现的审计修正：callId 键维度、工作目录解析、后台子代理锚边界

**背景**：第 59 条提交（`4fea24b`）后做了一次独立全链审查（只读子代理，报告在仓库外）。
结论「有条件通过」：无 blocker，3 个 major + 1 个接线测试空洞。

**M1 `callId → owner` 键丢了会话维度**：
- 证据：`exec.callId = block.id` 由 provider 铸造（`dsh-agent-loop/lib/index.js:512`），DSH 只
  约束会话内的 call→result 关联（`dsh-session/lib/index.js:1217`），没有进程级唯一分配器；
  审查扫本机 474 份日志，14860 个 callId 里 32 个跨 4 个会话重复（`session/fork` 复制日志，
  `dsh-session:2008`）。原 `FileSnapshots.pending` 的键已经是 `sessionId:callId`。
- 后果：两个会话/兄弟子代理拿到同一 callId 时，一方的 commit 会按另一方 owner 提交 →
  A 工作区的路径写进 B 的 journal（B 撤回时改到 A 的文件），A 的 pending 永久泄漏，且不报错。
- 修：抽出 `snapshotOwnerKey(session, callId) = "sessionId:callId"`；capture/commit/drop
  都用执行会话重算键；`exec.callId` 缺失直接返回。

**M3 相对路径按 `header.cwd` 解析（可能删错文件）**：
- 证据：`write`/`edit` 按 `ctx.workingDirectory.ensure(agent)` 的当前目录解析
  （`dsh-tool-fs/lib/index.js` session-cwd）；子会话 `header.cwd` 复制自父会话
  （`dsh-subagent/lib/index.js:350`），实际工作目录是 `create.cwd`（`:1524`，
  `workingDirectory.set(child, create.cwd)` 在 `:1804`）。
- 后果（真反例）：父会话在 /repo、子代理 `cwd:"sub"`、`write {"file_path":"note.txt"}` 实际写
  /repo/sub/note.txt；快照却 stat /repo/note.txt 并记成"新建"（backup=null），撤回时若
  /repo/note.txt 已被别人创建就会被删除（rescue 有副本，但 UI 不提示）。`cd` 后的根会话
  自己也有同样问题。
- 修：`workingDirectoryOf(session)` 优先
  `ctx.get('workingDirectory')?.get(session)`，服务缺失/异常才回退 `header.cwd`；
  测试用 `workingDir` 字段显式建模该服务，并断言 `header.cwd ≠ workingDir` 时按后者解析。

**M2 后台子代理的锚是"执行时"而不是"派发回合"（未改代码，文档化）**：
- 子代理工具立即返回（`dsh-tool-subagent`），父回合结束后它仍可能继续写文件；锚取
  "执行时根会话最新人类消息"，不是派发它的那条消息。
- 反例 A：H1 派子代理 → 父回合结束 → 用户发 H2 → 子代理在 H2 期间写文件 → 撤回 H2 会
  回退这些文件，尽管派发它们的是 H1（对话里 H1 的派发仍在）。
- 反例 B：撤回 H2 时子代理仍在跑（`settleAgentForRevert` 只取消根 agent）→ 撤回后根会话
  最新人类消息回落到 H1，子代理随后写的文件锚到 H1；两消息会话里 H1 是首条（首条禁止
  撤回），这些改动**再也撤不掉**。
- 处理：写进 `docs/REWIND.md` 已知限制，把"父 both 撤回会回退子代理文件"改成有条件表述；
  "派发回合取锚"（用子会话投递消息的 time，在根表面按 time<=该时刻定位）留作后续设计。

**M4 测试与探针补齐**：
- `harness/rewind-merge-check.mjs` 31 → 37 条：新增 fork 形状（`parentSession` 但非委派必须
  停在自身）、owner key 跨会话不同、工作目录解析、同路径父子先后写（earliest-touch 恢复）。
- 新增 `harness/rewind-merge-e2e.mjs`：真机可复跑探针（父写 + 子代理写 → both 撤回 →
  两个文件都删除、子会话无 journal）。
- `harness/replay-fidelity-probe.mjs` 的期望改为从原始 `surfaceOps` 独立推导（不再是
  fold-vs-fold），带缝日志与干净日志各 4/4。

**仍存在的边界**：M2 语义在提交时未改（第 61 条已落地：锚绑派发回合 + 撤回范围取消）；
rescue 覆盖手动改动无 UI 提示；fail-open 只有固定日志行、无原因码；server 接线（事件顺序）
仍无离线覆盖，靠真机探针兜底。

> **教训**：审查「键」和「路径」这类基础设施维度时，要直接查上游契约（callId 唯一性、
> 路径解析入口），不要因为默认 provider 行为"看起来没问题"就放过——它们决定的是
> 错归/错删这类**无声故障**。另外，测试如果自己复刻了被测实现的关键判断，就只证明了
> 复刻是对的；真机探针要入库、可复跑，才算验收证据。

### 61. 撤回后的会话重开把活着的子代理误标 canceled；派发回合锚与撤回取消

**症状**：撤回一条「派遣子代理之后」的消息后，仍在运行的后台子代理在 Paseo 里变成
已取消/停止；实际它还在后台跑完。

**真机复现**（2026-10-19，真实 Paseo daemon 路径：`paseo run` 建 agent → 派后台子代理跑
60 秒、每秒写 progress.log → 发后续消息 → 用 DaemonClient 发 `agent.rewind.request` 撤回
后续消息）：
- daemon 日志：`parked:park … (size 1)` → `parked:take …` → `agent reload … exited 0`
  （同一 dsh 进程被停放复用，**没被杀**）；
- 插件日志：`subagent 499cbf5d…: stored history ends with no turn terminal (the last turn was
  never closed); closing it as canceled`；
- 子会话日志之后仍写入 `seq 31 turn/end {reason: completed}`，progress.log 60 行写满，
  父会话收到 DONE；
- daemon 的 provider 子代理行 `status: "canceled"`。

**根因链**：
1. 撤回刷新 = 关 provider 会话 + 带 persistence 重开（`reloadAgentSession(rehydrateFromDisk)`）。
   **重开前** daemon `cancelRunningProviderSubagents()` 把子代理行标 canceled；清行的
   `deleteParent` 反而在**重开之后**的 `resumeSession` 路径里（本机 0.11.2
   `@getpaseo/server` `agent-manager.js:867-885`）——所以旧行先被标 canceled，接着靠插件
   `replaySubagents()` 重新播报重建。重放判错就会直接表现为「子代理消失/停止」，而不是
   一个可自愈的短暂状态。
2. 插件 `session.close({park:true})` 只在根回合空闲时停放 → 进入停放池（进程存活）。
3. 重开后插件 `replaySubagents()` 用 `announcedLive = #children.has(id)` 判活：新 provider
   会话没有桥的再次播报（桥里该 child `opened=true`，不会对第二个会话重发
   `session.child-opened`）→ 历史停在 turn 中途 → 按被杀处理，收尾 canceled。**子代理实际
   仍在跑**，只是 UI 与后续事件归属错了。

**修法**：
- 插件 `DshSession` 记录 `#adoptedParkedProcess`（`open()` 取到停放进程时置 true）；
  `replaySubagents()` 的 `announcedLive` 改为 `#children.has(id) || #adoptedParkedProcess`——
  接管的同一进程里「历史停在 turn 中途」是活证据；冷启动仍按被杀处理。
- 桥新增 `dsh-bridge/lib/child-anchors.js`：子会话每次 `turn/start` 记录
  「根会话当时最新人类消息 seq」（派发/续接回合）。文件快照优先用该锚，修掉第 60 条 M2 的
  跨轮归属问题。
- `revert()` 在 append+flush 之后、文件 restore 之前调用 `cancelWithdrawnDelegations()`：
  锚 `>= targetSeq` 的子代理通过 DSH `subagents.interrupt(childId, {kind:'ancestor', agent:根agent})`
  中止；锚更早的保留继续运行。`interrupt` fire-and-return；锚未知不取消（保守）。

**验收**：`rewind-merge-check` 45/45（新增 ChildAnchors 8 条）；`subagent-check` 64/64
（新增 adopted 重开不 canceled、冷启动仍 canceled、子代理仍播报 3 条）；`file-snapshot` 41、
`revert` 98、`surface` 18、`revert-shape` 10、`plugin-check` 32、`parked` 27；`tsc --noEmit`
干净；内嵌桥 16 文件已重生成。

**边界**：`interrupt` fire-and-return（子代理可能再写几笔）；未知锚不取消；续接子代理在新
`turn/start` 刷新锚；取消保留 Activation/pending inbox，可被再次唤醒。

> **教训**：**「进程没死」不等于「UI 认为它活着」**。provider 会话的 close/reopen 是刷新
> 时间线的必要路径，任何跨会话存活的对象（这里是从子会话重放出来的子代理）都必须有明确的
> 「仍在运行」证据来源，否则重放只能默认「它已被杀」——这个默认会让用户以为后台工作停了。
> 同时，活着的子代理必须与「撤回范围内的副作用」绑定：撤回覆盖派发回合就该真停，否则它会
> 继续在已撤回的指令上写文件。

---
### 62. 撤回实现全量审查：7 个桥侧 major + 7 个插件侧 major 的修复

**背景**：第 59/60/61 条把父子归并、派发回合锚、范围内中断做完后，用两个**全新上下文、
只读**的审查子代理分别审「桥 + 测试资产层」与「插件 + 生命周期 + 协议 + 文档层」
（报告存 `/tmp/full-review-{bridge,plugin}.md`，不在仓库）。两侧均「有条件通过，无 blocker，
7 个 major」。主代理逐条核实后确认，仅一条插件侧断言为误报（见下）。

**桥侧（`dsh-bridge/`）修复**：
1. **pending 键撞 callId**：父子共享 owner 命名空间后，`FileSnapshots.pending` 仍用
   `owner:callId`；同 callId 的两次 capture 后一次覆盖前一次，一方编辑静默不进 journal。
   改为 pending 键 =「执行会话 id + callId」（`pendingKeyOf`），journal/objects 仍归 owner。
2. **恢复取了 commit 顺序**：journal 行按 commit 追加，父子并行编辑同一路径时可能反序；
   `planRestore` 取「文件里第一行」会恢复成子代理的中间态。每行新增进程内单调 `captureSeq`，
   恢复按它取最早捕获；无该字段的旧行按旧文件序（它们本来就比新行早）。
3. **部分恢复失败仍 prune/GC**：失败路径的撤回前备份与 journal 行被删，不可重试；插件还把
   rescue（当前内容）说成恢复材料。现在有任一失败就跳过 prune/trim/GC，回执 + stderr +
   插件提示共同说明「备份保留、可重试；rescue 是被替换的当前内容」。
4. **GC 与未提交 capture 竞态**：capture 先写 objects、后（post-execute）才 commit journal；
   撤回期间的 GC 会把在跑子代理刚写的对象当未引用删掉，journal 随后引用缺失对象、恢复必失败。
   GC 现在排除 pending 里的 backup，并保留 5 分钟内新对象（`GC_GRACE_MS`）。
5. **flush 失败被吞**：`sessions.flush` 失败只写 stderr 仍返回成功；reload 读旧日志会把被撤
   内容复活，文件却已回滚。现在 flush 失败（或 profile 无 session store）直接抛错，且不取消
   子代理、不动文件。
6. **restore 信任 journal**：绝对路径/哈希不校验、跟随符号链接，`backup` 可 `..` 穿越
   objects。`readJournal` 只收绝对路径与 64 位十六进制哈希；`restore` 用 `lstat`，符号链接/
   目录/socket 一律跳过；新增 harness 用恶意 journal + symlink 验证。
7. **trim 静默丢可达锚点**：原「只留最新 100 锚点」在 >100 锚点会话里，先撤较新目标后再撤
   更早目标会漏恢复。trim 改为「删掉最早可撤回人类消息之前的锚点（未来撤回永远选不到）」，
   1000 锚点仅作硬上限且超限记 stderr 警告；bridge 用 `minRewindableAnchor(session)` 计算底线。
8. **取消策略可测**：把「哪些 child 被 interrupt」抽成 `delegated-cancel.js` 纯函数
   （interrupt 注入），补 harness：child 集合/顺序、一次拒绝不中断其余、未知锚不猜、目标之后
   不调用；桥在 interrupt 后最多等 3s（`waitForChildren`）再恢复文件。
9. **fork 形状误报**：审查称「DSH fork child 实际带 `origin:'subagent'`，会被归并」；核对本机
   DSH `SessionStore.fork`（`dsh-session/lib/index.js:2015-2021`）只写
   `{cwd, parentSession, isSeeded}`，无 origin/depth，现有 fork fixture 正确。

**插件侧（`paseo-plugin/`）修复**：
1. **重放窗口丢子会话事件**：`replaySubagents()` 先 await 每个 child 的 history 再打开；期间
   到达的 `turn/end` 被当未知 child 丢弃，adopted 子代理永久 running。现在 listing 后先把
   这些 child 的实时帧缓冲（`#replayPending`），重放后立刻派发；缓冲里已有 `turn/end` 时
   重放不再先发 canceled（`terminalBuffered`）。
2. **adopted 语义过宽**：进程级布尔把「从未开始 turn」的 child 也当活，只有「历史停在 turn
   中途」才是接管进程的活证据。现在 `live` 只在 `turnOpen` 时放行，`!sawTurn` 仍 canceled；
   补 adopted + 无 turn 用例。
3. **撤回 prompt 门两个洞**：刷新期间重复撤回的失败路径会删掉第一次的门；`session.close`
   就删门，close→reopen 间隙的 prompt 变成 `runtime_failed`。现在重复撤回直接
   `request.failed` 且不碰门；门保持到新会话 `session.ready`（`#open` 末尾释放），窗口内
   prompt 回可读的「正在回退，请稍候」。
4. **open 部分失败泄漏**：`configure({thinkingOption})` 在清理 try 之外，抛错会留下
   `#sessions`/`#agentIds`/dsh 进程。post-open 初始化全部并入同一 try，失败统一
   delete + `close({park:false})`（并由 tsc/假桥验证）。
5. **history `available:false` 当空历史**：改为跳过该 child、发
   `session.notice`（「子代理历史读取失败」），不再冷启动按 canceled / adopted 按 running
   去猜一个不可读的日志。
6. **文档修正**：第 61 条把 `deleteParent` 写成「重开前」，实际在重开后的 `resumeSession`
   路径（`@getpaseo/server` `agent-manager.js:867-885`）；REWIND 的 fail-open 措辞改为
   「该子代理编辑不记录」、adopted 只对 turnOpen、补 flush/trim/GC/rescue/门/等待边界。

**验收（2026-10-19，本机）**：`file-snapshot` 49/49（新增 capture 顺序、pending 键、
恶意 journal/symlink、trim 语义、GC pending/宽限）、`rewind-merge` 49/49（新增取消策略 4 条、
删掉 1 条自证断言）、`subagent-check` 68/68（新增 adopted 无 turn、history 不可读、重放窗口
竞态各 1 条）、`plugin-check` 32/32、`parked` 27/27、`revert` 98、`surface` 18、
`revert-shape` 10、`replay-fidelity` 4/4×3 份真实日志、`tool-call` 331/331、
`tsc --noEmit` 干净、内嵌桥重新生成后字节一致。真机（重新部署 profile 桥后）：
`rewind-merge-e2e` 13/13（父+子写 → both 撤回 → 两文件删除、根 journal 两行、子会话无
journal；stderr 出现 `interrupted 1 delegated agent(s)`）、`rewind-e2e` 12/12
（撤回、文件删除、surface 1 条人类消息、无 command/run、模型知道 ALPHA 不知道 BETA）。

**教训**：**并发与失败路径才是撤回的数据丢失面**——正常路径的离线断言早已全绿，丢文件的是
「谁先 commit」「GC 和写对象谁先跑」「恢复失败后还 prune」「flush 失败仍报成功」这些次序；
另外**取消是 fire-and-return，恢复不能假设它已生效**，必须等一个有界窗口并把超时说出来。

### 63. iOS 上传 zip 报 `[System Error] unsupported prompt content type "uploaded_file"`

**背景**：Paseo 0.12 手机端把附件（zip 等）以 `uploaded_file` 内容块下发：文件已由 daemon 落盘到
`~/.paseo/uploads/<id>/<fileName>`，块里带 `fileName/mimeType/size/path`（绝对路径）。
插件 `paseo-plugin/server/session.ts` 的 `toDshContent` 只认 `text`/`image`，其余一律抛
`unsupported prompt content type "<type>"`，于是整个提问失败，报 `[System Error]`——文件其实好好的，
只是桥不认这个块。

**根因不是"DSH 不支持附件"**：Paseo 自己的 provider（Claude、Codex、OpenCode、Pi）收到这些块时都
`renderPromptAttachmentAsText()` 渲染成**文本**再交给底层 agent，官方从不复制文件、只给绝对路径
（`@getpaseo/server@0.12.0` `dist/server/server/agent/prompt-attachments.js:30-110`；Claude 侧
`providers/claude/agent.js:2922`、Codex 侧 `providers/codex-app-server-agent.js:2437`）。

**修复**（`paseo-plugin/server/session.ts`）：`toDshContent` 改为 text/image 原样、其余交给逐字移植的
`renderPromptAttachmentAsText`：
- `uploaded_file` → `Uploaded file: <fileName>` / `Path: <path>` / `MIME: <mimeType>` / `Size: <n> bytes`（四行，字段顺序照抄）
- `review` → `Paseo review attachment (<mode>)` + `CWD:`/`Base:` + 每条 comment 的 hunk 与 diff 行
  （目标行前缀 `> `、其余两空格；行号 `padStart(2)`，缺行号渲染 `-`；add/remove/context → `+`/`-`/空格）
- `forge_change_request`/legacy `github_pr` → `<显示名> <PR|MR> <前缀#|!><n>: <title>` + url + Project/Base/Head/body
- `forge_issue`/legacy `github_issue` → `<显示名> Issue <前缀><n>: <title>` + url + Project/body
- 显示名/缩写/编号前缀取自 `@getpaseo/protocol/forge-manifest`（github/gitlab/gitea/forgejo/codeberg，
  未知 forge 走 neutral）；表是**照抄的数据**，@getpaseo/server 不是插件运行时依赖。
- `text` 块 / 文本附件块 / `image` 块行为逐字不变；**真正未知的类型仍抛错**（带 wire type），不静默丢。

**验证**：新增 `harness/uploaded-file-check.cjs`（17/17，编译到仓库内 `.dbg-attach`，
详见文件头运行步骤）；11 个 fixture 与官方 `renderPromptAttachmentAsText` 的输出**逐字节比对一致**
（含无 forge 的 neutral 怪癖 `undefined PR #3: …`，有意保留上游行为）；两条变异验证
（删 `" bytes"` → 3 条 FAIL；未知类型改静默返回 → 2 条 FAIL，还原后 17/17）。
`harness/subagent-check.cjs` 里「无 DSH 对应物的块必须失败」的 fixture 随之从 `uploaded_file`
改成真正未知的 `mystery_attachment`（68/68），否则它会断言这次已支持的块仍应失败。
真机 plugin-check 32/32。

**教训**：**「协议比我认识的宽」时先看上游适配器怎么翻译，而不是抛错**——抛错看起来"响亮"，
其实用户看到的是整个提问不可用；同时**对齐要连边角一起照抄**（neutral 兜底、diff 行前缀、字段顺序），
否则"差不多"的格式会在下一次上游改动时静默漂移。

### 64. `agent_message` 行在真机退回原文：0.12 App 的插件边界重建 item 时丢了 `agentMessage`

**症状**：0.12 适配给 `agent_message` 行加了语义渲染（事件 + 发送者 + 正文），离线喂
daemon 投影形状的 fixture 是语义行，**真机上那一行仍是 `agent_message` 加原文**。不是 bundle
缓存：同一份代码、同一份 fixture，差别只在"字段到没到插件手里"。

**根因（在宿主，不在本仓库）**：daemon 的投影**带**字段——`projectAgentMessage` 产出
`tool_call{name:"agent_message", agentMessage:{event,sender,text}, detail:{type:"plain_text",…}}`
（`@getpaseo/server@0.12.0` `dist/server/server/agent/agent-messages/index.js:127-155`）。但 App 在把
timeline entry 交给插件 transformer 之前**重建 item**，只挑选
`callId/name/status/error/detail/metadata`：
`const{callId:s,name:n,status:o,error:c,detail:u,metadata:l}=t; p=Object.assign({type:"tool_call",callId:s,name:n,detail:u},l?{metadata:l}:{})`
——**没有 `agentMessage`**；随后 `function c(t,n,c)` 调 `n({item:s(u),phase:I,sourceId:t.id})`
（0.12.0 web UI bundle `.../server/dist/server/web-ui/_expo/static/js/web/index-07fb71ae403dd83a2c7484a3338718f8.js`，
模块 **4778**：`projectPluginTimelineItems`；重建函数是同一模块里的 `function n(t)`）。于是插件的
transformer 永远看不到 `agentMessage`，只能落到 `plain_text` 分支，行头读成 wire name。

**为什么"交还宿主"是正确兜底**：同一 bundle 的 `transformTimelineItem`（模块 **4837**）对 `undefined`
的处理是 `if(void 0===f)continue; return n(f).items.map(...)`，调用方 `return void 0===f?[t]:…`
——**插件返回 `undefined` 即"保留源 item"**。源 item（重建之前那份）里 `agentMessage` 还在，
Paseo 自己的行用官方 `buildAgentMessageDisplay` 正常渲染（事件标签 + 发送者）。所以最小修法不是
去解析 `detail.text`（仓库规则：字段的载体由协议定义），而是**把这一行还给宿主**。

**修法**（`paseo-plugin/index.client.tsx`）：tool_call transformer 在映射前加一个分支——
`item.name === "agent_message" && item.agentMessage === undefined` → `return undefined`；带
`agentMessage` 时照旧走语义渲染（上游修好后自动受益，插件无需再改）。分支注释写明原因与回退条件。

**验证（本机 Node 22.23.1，2026-10-20）**：`cd paseo-plugin && npx tsc --noEmit` 干净；
`harness/agent-message-check.cjs` **111/111**（新增 8 条：guard 存在、位于 `toolCallData` 之前、
条件在「无字段 / 字段为 undefined / 带字段 / 别的 tool_call」四种形状下分别命中或不命中、
且不解析 `detail.text`/`plain_text`；该 `.tsx` 不能离线 require，故为源码级断言）；
`harness/tool-call-check.cjs` **335/335**。变异验证两轮：删掉 guard → `FAIL the missing-agentMessage
guard exists`（105 passed, 1 failed）；把条件改成无条件 skip → 同样 FAIL（105/1）；两次还原后均 111/0。

**何时可回退**：上游把 `agentMessage` 一并传给插件（或 timeline 契约改成整条透传）之后，删掉这个分支即可。
判据：真机 `agent_message` 行走**我们**的语义行（中文事件标签 + 发送者），而不是 Paseo 官方的英文标签。
在此之前，该行显示官方英文标签，是**有意的降级**，不是缺陷。

**教训**：**「离线 fixture 全绿」证明不了真机——宿主插件边界会重建 item**。凡"接管/替换宿主 timeline 行"
的插件，都要按「协议字段可能在入口被筛掉」设计：先确认字段真的到了插件（打一条日志或看宿主 bundle 的
重建函数），再决定兜底；兜底应**交还宿主原生渲染**，而不是从旁路载荷（`detail.text`）里把内容猜回来——
那只是把一次静默降级换成另一次。

---

### 65. 取消归档后每条消息都 `blocked`：归档集只写进了磁盘，没写进那个还活着的进程

**症状**（2026-10-22 真机）：在 App 里归档一个会话，再点「取消归档」，之后给它发消息，回合
**约 160ms 就失败**，界面提示 `the turn ended with blocked`。看着像模型或上下文问题，其实
连模型请求都没发出去。

**取证链**（每一环都有据，纯读码推断不算）：

1. `~/.paseo/daemon.log`：`handleStreamEvent: turn_failed`，`error: "the turn ended with blocked"`。
2. 会话日志（多帧 zstd，`zstd -dc`）末尾只有三帧：`turn/start {turn:25}` →
   `agent/inbox/spliced {removedCount:1}` → `turn/end {reason:{kind:"blocked"}}`，
   **没有 `step/start`**——说明根本没发起模型请求。
3. DSH 里 `blocked` 只有一个来源：`preStep` 返回 `{kind:"reject"}`（`@deepseek-ai/dsh-agent-loop/lib/index.js:959-961`）。
   注册 pre-step 且会 reject 的只有两处：**archived-session-gate**（`dsh-api-session-controller/lib/types/archived-session-gate.js:20-24`）
   与 goal 轮次驱动。该会话日志里没有任何 goal 事件，goal 一路排除。
4. 归档门禁读的是**进程内存**：`ctx.workspaceRegistry.archivedSessionIds`（同一文件第 36 行）。
   它没有任何跨进程失效机制——谁执行了归档调用，谁的这份数组才变。
5. 时序（对得上到毫秒）：处理这条消息的 dsh 进程启动于 `06:08:17`（`/tmp/dsh-paseo-mcp-*/` 创建时间），
   而 `~/.dsh/storages/workspace.json` 的写入时间是 `06:08:21.893`；插件日志同一秒是
   `parked:park`(.891) → 落盘(.893) → `parked:take`(.910)。**进程比取消归档落盘早约 5 秒**，
   它启动时读到的归档集里还有这条会话，之后没人告诉它"已经取消了"。

**根因**（在插件侧，不在 Paseo）：Paseo 归档/取消归档前会**先关掉该会话**，于是请求到达时
`#sessions` 里没有持有它的打开会话，旧代码就退回一次性 probe 进程去改——**只改了磁盘**。
紧接着 App 重开，插件从停放池**取回原来那个进程**（`parked:take`），它的内存归档集还是旧的，
门禁于是否掉这个会话的每一个回合。`#setArchived()` 的注释当时只写了"记录落盘"和"停活由持有进程做"，
漏了第三种后果：**读这份记录的也是进程内存**。

**修法**（第一版改错了，独立复核把它拦下来）：

- `ParkedSessions.discard(dshSessionId, reason)`：把停放进程移出池并 kill、记入 dying 名单——
  于是下一次 open 的 `quiesce()` 会等它释放会话日志的写锁，不会撞上 "already owned by an
  active write handle"。miss 不是错误（未停放时是 no-op）。
- `#setArchived()` 的候选顺序**保持不变**（已打开且持有该 id 的会话 → 其他已打开会话 → 一次性
  probe），但**任何非持有者的成功承载之后，都要把该会话的停放进程 `discard` 掉**：它就是重开
  时会收养的那个进程，门禁读的是它的内存，留着它就会继续拒绝这个会话的每一个回合。

**为什么不是"让停放进程自己承载"**（第一版的做法，已废弃）：`registry.archiveSession` 会把
**整份** `archivedSessionIds` 写回磁盘，而停放进程手里的那份是它**启动时**读到的快照——跨进程
没有任何失效机制（storage 层无 `fs.watch`，`dsh-storage-json` 明确"内存权威、只在 open 时读一次"）。
于是"归档 A 之后再由 B 的停放进程归档 B"会把 A 的归档从盘上抹掉，而且**事后补一次 probe 也救不
回来**（probe 读到的已经是被覆盖的盘）。独立复核用两个 storage 实例做了机制级实证。代价是这种
情况下重开会冷启动一次（1.5–2.7s），但归档/取消归档是低频动作，宁可慢一次也不丢归档状态。

**验证**：`harness/subagent-check.cjs` **78/78**（新增 5 条：停放进程有自己的 pid、停放期间
unarchive 有回执、**停放进程绝不承载这次写入**、**陈旧停放进程确实被作废**（直接抓插件自己的
`parked:discard <id>` 日志行，避免负向断言空过）、**重开冷启动而不是收养那个陈旧进程**）；
`harness/parked-sessions-check.cjs` **32/32**（discard 语义 + discard 后 quiesce 会等，
**该脚本已删**：discard 与整个停放池随 reload 旁路移除，见本条开头的历史记录）；
`harness/steer-check.cjs` **25/25**、`harness/bridge-assets-check.mjs` **2/2**、`tsc --noEmit` 干净。
假桥的 `DSH_FAKE_LOG` 每行现在带 `pid`（区分"哪个进程服务的请求"是这条回归的关键）。
**变异验证**：把 `discard` 换成空函数 → **76/78**，红的正是上面第 4、5 条（`(no parked: line)`、
`pids 719155 vs dropped owner 719155`）；还原后 78/78。另：第一版测试把 unarchive 发在
**第二条连接**上，因此永远走不到停放池——那是脚手架形状问题（假桥脚本每个 connection 一个
provider 实例），真实 daemon 是**每个 provider id 一个连接**（`PluginAgentClient` 缓存
`ProviderRuntime` 的单一 connection）。

**独立复核（两轮，只读、产物在 /tmp）**：第一轮拦下了"让停放进程自己承载"的第一版修法
（会用陈旧快照覆盖其他会话的归档，机制级实证），并确认根因链每一环与 `discard`/`quiesce`
的写锁时序；第二轮确认 clobber 已消除、剩余陈旧写者与改前同集合、`#dying` 64 条挤出与
"承载期间被重开抢先"两条窄缝属既有残余（后者在生产上被 Paseo 的
`unarchiveSnapshotUnlocked` 先 await 回执再重开闭合）。

**遗留（本次未修，与既有代码同源）**：`#setArchived()` 的"持有者优先"路径同样会让一个**长期
运行的打开会话**用它的内存快照写回整份归档集，多会话交替归档时同样可能覆盖。要根治得让
"写归档集"只由**读盘最新**的进程承担（或桥侧先与磁盘对齐），那会动到"停活在持有进程里做"的
既有语义，留待单独评估。

**真机注意**：daemon 的 `PluginAgentClient` 每个 provider id 只缓存**一个**连接
（`@getpaseo/server/dist/server/server/agent/plugin-provider.js:225-245`），所以每个 agent 的
归档请求都会到达停放它的那个进程——这条修复依赖这个事实；假桥脚本里"每个 connection 一个
provider 实例"是测试脚手架的形状，不是 daemon 的形状。

---

## 第十五轮：MCP gateway 的传输面

### 66. Server Browser 的 25 个工具全量进每一轮请求：gateway 只认 HTTP，stdio 只能原生挂载

**症状**：无。没有报错，没有失败，浏览器工具该用的时候都在——只是**每一轮请求都带着
20072 字节的工具声明**。这是"静默降级"的近亲：静默降级是"能力悄悄消失"，这个是"能力
齐全、成本悄悄常驻"。两者都不报警，都只能靠算账发现。

**事实**：Server Browser 插件把它的浏览器能力以 **stdio** MCP server（`server_browser`）
注入，bridge 是个 `mcp-bridge.mjs` 子进程，**25 个工具、schema 合计 20072 字节**
（2026-10-24 实测）。而 gateway 只实现了 Streamable-HTTP 客户端（`mcp-http.js`），
`mcpEntries()` 遇到 `type:"stdio"` 一律挂原生 `@deepseek-ai/dsh-mcp-client`——于是这
25 个 schema 进**每一次**请求的 header，和 Paseo 自己那 61 个工具当年一模一样的问题，
只是换了个 server 名字。而一个会话里真正会调浏览器工具的次数，通常是个位数。

**根因不是"忘了优化"，是传输面缺一半**：gateway 的三件套（`mcp_list_tools` /
`mcp_tool_schema` / `mcp_call_tool`）只依赖 client 的三个方法，本来就与传输无关；缺的是
一个 stdio 客户端。补上它之后，同一个 gateway 行同时容纳两种传输。

**修法**：

- `dsh-bridge/lib/mcp-stdio.js`：手写的最小 stdio JSON-RPC 客户端，与 `mcp-http.js` 对称。
  **不引 `@modelcontextprotocol/client`**——桥整个被打成 base64 嵌进
  `server/bridge-assets.ts` 随插件分发，装不了包；而且 gateway 只需要
  `ensureInitialized` / `listTools` / `callTool` 三个方法。协议要点都是踩过的：一行一个
  JSON-RPC 消息、**stdout 的非 JSON 行必须忽略而不是抛错**（Playwright MCP 会往 stdout
  打日志）、子进程退出时所有 pending 必须 reject 而不是悬挂、超时逐请求计时。
- `dsh-bridge/lib/mcp-gateway.js`：`servers` 每项从 `{url, headers}` 放宽成联合
  （HTTP 或 `{command, args, env, cwd}`），`clientFor()` 按字段选客户端。三个元工具一行没改。
- `paseo-plugin/server/dsh-process.ts`：加白名单 `GATEWAY_STDIO_SERVERS`，当前只含
  `server_browser`。**白名单不是优化开关，是正确性要求**，理由见下面教训。

**为什么不是"所有 stdio 都走 gateway"**：用户自己配的 stdio MCP（`github` 这类）需要
**完整 schema 直接可见**才可用——模型得先看到工具名和参数才能决定用哪个。被代理之后，
每次调用前要先 `mcp_list_tools` 查一遍、再 `mcp_tool_schema` 查一遍，三轮换一轮，这
不是省钱，是把"能直接用"退化成"要先摸索"。所以只有**工具多、调用少、能力窄**的 server
（浏览器：25 个工具，一个会话点几次）值得代理；通用工具集不在此列。

**验证**：`harness/mcp-stdio-check.mjs`（新增，纯离线，假 server 驱动：握手顺序、
`tools/list` 缓存与 `refresh`、`tools/call` 参数、JSON-RPC error 变 reject、stdout 混入
非 JSON 行、超时、子进程退出不悬挂、`dispose`）；`harness/mcp-injection-check.cjs` 补了
白名单断言（白名单 stdio 进 gateway 的 `config.servers` 且不产生原生条目、非白名单 stdio
仍原生、三者混装时条目数与归属）。**改了 `dsh-bridge/` 之后照旧先跑
`harness/bridge-assets-check.mjs`**——内嵌桥不同步的话，上面两条都会在旧桥"假绿"。

**教训**：**「工具全量注入」的成本只会在账单和上下文占用里出现，不会在日志里出现。**
判断一个 MCP server 该不该代理，看的是三个比值而不是传输类型：工具数 / 每会话调用次数、
schema 字节数 / 它省下的探索轮数。另一个教训是**能力面要按"最小可用"设计**——手写 80 行
stdio 客户端换掉一个 20 KB 的常驻成本，比重写整个 MCP 层划算得多；反过来说，任何"这个
传输我们还不支持"的分支都该在注释里写清代价，否则下一个人只会看到"它能用"。

---

## 已知限制（未修，有意为之）

| 项 | 说明 |
|----|------|
| `assistant/attempt` 被丢弃 | 该事件承载失败/重试/取消的尝试，所以**重试的持久记录在界面上不可见**。但流式上线后，一次"已经流出一部分才失败重试"的 attempt，其已发出的前缀会留在时间线上（Paseo 时间线 append-only，无法撤回，见第 25 条）。`AssistantStreamRecord` 没有错误变体，无法可靠区分"失败重试"和"用户主动取消"，所以持久记录仍不加，乱加会在每次取消时刷噪音。 |
| 时间线只映射 13 种会话事件里的 4 种 | 其余多数是有意丢弃：`developer/message`、`system/message` 是系统提示，`request/header`、`request/context` 是内部记账。流式另走桥自有的瞬时类型 `paseo/assistant-delta`，不进会话日志。 |
| 可续接子代理二次运行的状态不回到 running | Paseo 0.11.2 的 provider 子通道忽略子会话的 `session.turn started`、`session.usage`、`session.permission`。子卡首次打开即为 running，终态（completed/failed）仍会更新，但再次运行的 started 不会恢复运行中状态。需 Paseo 核心补丁，本仓库不改全局包。 |
| 子代理审批不在 Paseo 出现 | 同上：子会话的 permission 事件被宿主忽略。桥只把根会话的问题转发给 Paseo，子会话问题保留 DSH 自身的子代理审批语义，避免挂起或误归属父会话。 |
| 子代理运行中状态/用量/审批需 Paseo 核心补丁 | 精确方案：`@getpaseo/server` 的 `agent/plugin-provider.js` `acceptChildEvent`（本机 0.11.2 行 1217-1248）需额外消费子 `session.turn started`（恢复 running）、`session.usage`（子用量）、`session.permission`（子审批卡），并把子 permission 经会话 id 路由到子代理视图。本仓库不改全局包；插件侧已按正确子身份发出这些事件，补丁落地即生效。 |
| provider 子代理（DSH 原生 child）的「归档」只写 App 内存，重启必复活 | 实测：App 的 `createArchiveFinishedSubagents` 把行分两类 —— `kind:"paseo"` 走 `archiveAgent`（→ provider 原生归档，落到 DSH registry），`kind:"provider"` 走 `useProviderSubagentStore.hideFromTrack`，**只写客户端内存 `Set`，不发任何请求、不持久化**（`hideFromTrack` 的实现就是 `new Set(t.hiddenFromTrack)`，还只藏非 running 的）；provider 行在 `SubagentsTrack` 里**连归档按钮都不渲染**（`"paseo"===kind ? <RowActions onArchivePress/> : null`），归档资格判定 `Boolean(t && !t.archivedAt && parentAgentId===n && (idle|error))` 也带 `archivedAt` —— 那是 Paseo agent 才有的字段。宿主 server 同样接不住：`plugin-provider.js:564` 把 `restoration:"parent"`（provider 子会话）的 persistence handle 丢成 `null`，`agent-manager.js:3773` 的 `syncNativeArchiveState` 于是 `if (!persistence) return` 静默跳过（catch 也只 `best-effort` warn），`provider-subagents/store.js` 的 descriptor 里根本没有 persistence/archived 字段。**证据（本机 0.11.2 bundle + daemon 日志 + registry 文件）**：23:29 归档 3 个 Paseo agent 时 `archive_agent_request` 有 3 次、registry mtime=23:29:52、3 个 DSH id 都在 `archivedSessionIds` 里；而 00:00–00:35 用户归档子代理期间 **0 次 `archive_agent_request`**、registry 未被写、插件日志无输出；00:12/00:17 App 重启后各有 13/12 次 `agent.provider_subagents.list.request` 把它们全拉回来。**本仓库侧已就绪**（真 profile：对真子代理发 `paseo/archive` → registry 94→95、`paseo/subagents` 该行 `archived:true`、`replaySubagents()` 跳过、unarchive 复原，5/5；假桥：插件把 child handle 解析成 **child 自己的** DSH id，4/4）。**需 Paseo 核心补丁**：① App 的 provider 分支改发服务端归档、失败要在 UI 提示；② `plugin-provider.js:564` 为 `restoration:"parent"` 保留 persistence（插件 `DshChildSession.open()` 已经带了 `{version:1,data:{sessionId:<nativeId>}}`）；③ `syncNativeArchiveState` 不再静默跳过、失败冒泡；④ `provider-subagents/store.js` 增加 archived/persistence。最小改法：App 发一条新请求，server 用 childId 构造 `{version:1,data:{sessionId:<childId>}}` 调 `runtime.archive` —— 插件已能解析。 |
| 子代理列表固定"旧→新"，要滚到底才看得到最新的 | 顺序由**宿主 App** 决定，不是在插件侧：宿主按自己盖的 `createdAt` **升序**排（最旧在上）。服务端 `@getpaseo/server/dist/server/server/agent/provider-subagents/store.js` 的 `list()` 是 `.sort((l, r) => l.createdAt.localeCompare(r.createdAt))`，`createdAt` 只在首次 upsert 时写入（`apply()`：`previous?.createdAt ?? timestamp`）；而**决定性的那一遍在 App 里** —— web bundle 模块 4997 有三处 `sort((e,t) => e.createdAt.getTime() - t.createdAt.getTime())`（`useSubagentsForParent` / `selectProviderSubagentsForParent` / `selectSubagentsForParent`），客户端不理会服务端返回顺序、自己从 Map 取出重排，所以**只改服务端 `list()` 界面上不会有任何变化**。渲染器（模块 5004 `SubagentsTrack`）是 `c.map(t)` 直接铺，没有 `column-reverse`。公开插件契约 `ProviderEvent.session.opened` **没有时间戳字段**，宿主是在 `attachChild()` 收到 upsert 那刻自己盖的章，所以插件既改不了方向也改不了时间；方向是升序，真正最新的必然在最后，唯一能挪到顶上的办法是**伪造 `createdAt`**（不做）。顺序之所以"每次加载都一样"是确定性的：`descriptors` 是**纯内存 Map**（`constructor(){ this.descriptors = new Map() }`，不持久化），daemon 重启后重新盖章的时刻顺序 = 插件播报顺序 = DSH 的创建顺序，所以重盖出来仍按创建顺序递增；同毫秒并列时由 `Array.sort` 的稳定性（ES2019）兜底。**需 Paseo 核心补丁**：把 App 侧那个 selector 的排序反向（最小改法是在 `useSubagentsForParent` 的 `useMemo` 末尾 `reverse()`，一处覆盖两类行与嵌套分支；别只改渲染器，否则面板的 segments/「已完成 N 个」统计会与行序不一致）。实测 0.11.2：某父会话返回 55 条，`createdAt` 严格升序，最新的（就是那次调查本身）在最后一条。 |

## 关于"哪条路由能用"

这份记录里刻意不提任何具体的 provider、模型或端点——**你的路由和模型完全由你的
profile 决定**。同一个缺陷在不同人那里会表现成不一样的症状，所以照抄别人的路由表
没有意义，用 `npx paseo-dsh probe` 测自己的才是正路。
