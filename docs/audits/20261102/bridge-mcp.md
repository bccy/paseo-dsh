# bridge-mcp lane 审查报告（dsh-bridge MCP 与传输层）

- 审查基线：`2f71225`（main，工作区干净）
- 上一轮全量审查：`9298c28`（docs/FULL-AUDIT-20261031.md；本 lane 对应 BR-06/BR-07）
- 范围：`dsh-bridge/lib/mcp-gateway.js`(571)、`mcp-http.js`(488)、`mcp-stdio.js`(390)、`transport.js`(277)、`paseo-system-envelope.js`(235)、`approval.js`(39) 全量逐行
- 环境：DSH 0.2.1-rc.5 / Paseo 0.14.0 / Node v22.23.1
- 只读：未修改任何 tracked 文件（`git status --short` 仅有本报告目录）；未做 git 写操作；未启动 real profile / daemon / 模型回合

## 0. 结论先行

- **本 lane 范围自基线以来零改动**：`git diff --exit-code 9298c28..HEAD --` 六个文件为空。因此**没有“新引入”发现**，下表全部是基线已有；其中 BM-01/BM-02 就是上轮已报、至今**未修复**的 BR-06/BR-07。
- **无 P0/P1，无阻断性健康问题。** 当前 Paseo HTTP（无状态）主路径的列目录/取 schema/调用/错误仍可用；现有 6 个相关 harness 共 210 项检查全绿。
- **3 个 P2 契约缺口**必须先修：① `exec.signal` 完全未贯穿（取消后请求不中止、继续等待并成功返回，实测）；② `structuredContent` 被丢弃（纯结构化结果变“成功空内容”，实测）；③ `CallToolResult` 未按 MCP schema 校验，畸形/任务式结果变“成功空内容”（实测）。
- 其余为 P3：HTTP 错误不带 server/tool 上下文、catalog 无失效通道、`mcp_list_tools` 与一次真实 browser 探测耦合、音频/资源块全量进上下文、tool metadata 丢弃 `outputSchema/taskSupport`、信封 `source-server-id` 与上游解析器分歧、握手版本头缺失、server→client 请求不支持、图片临时目录无清理、分帧无字节上限等。
- 一句话总评：**传输与分帧的“已修部分”质量不错（线性分帧、会话丢失恢复、参数守卫都经过带判据的回归），但 MCP 代理层的取消语义与结果保真仍停在“能跑通 happy path”的水平。**

## 1. 范围、方法与证据边界

- 逐行读六个文件，并追调用链：`dsh-bridge/lib/index.js`（transport/approval 装配）、`server.js:1052-1083`（`promptSource` 消费）、`paseo-plugin/server/dsh-process.ts`（gateway 配置、permission 通知形状）、`@deepseek-ai/dsh-tools` / `dsh-mcp-client` 类型与实现、安装的 `@getpaseo/server@0.14.0` 解析器。
- 跑现有 harness（全部 exit 0，纯离线/loopback）：

| 命令 | 结果 |
|---|---|
| `node harness/mcp-http-check.mjs` | 55/55 passed |
| `node harness/mcp-stdio-check.mjs` | 22/22 passed |
| `node harness/transport-frame-check.mjs` | 20 passed, 0 failed（20 MiB 线性分帧，194x，随机分块与旧实现逐字节相等） |
| `node harness/mcp-gateway-guard-check.mjs` | 70/70 passed |
| `node harness/mcp-gateway-transport-check.mjs` | 10/10 passed |
| `node harness/paseo-system-envelope-check.mjs` | 33/33 passed |
| `node harness/p003-bridge-check.mjs` | 10 passed（含审批超时/撤回/畸形答复） |

- 针对本报告的候选问题另写了**临时探针**（`/tmp`，未提交；本 lane 只允许写本报告），全部驱动**真实模块** + loopback 假 MCP server + 已装 DSH/Paseo 包，不写 profile、不调模型：
  - `apply()` 真实注册 → 取 `mcp_call_tool.execute`，用 `exec.signal` 演示取消与结果映射；
  - `McpHttpClient` 直连假 server，抓请求头/错误形状；
  - `parsePaseoSystemEnvelope` 与安装的 `@getpaseo/server@0.14.0` `parseAgentMessage`/`prepareAgentMessage` 逐用例对照；
  - `McpHttpClient` 对“持续 404”会话丢失做有限性对照（结论：单路径会响亮失败、下一调用重建，未见无界重试）。
- 未验证项（见 §7）：真实 DSH 回合中的取消路径、真实 daemon/浏览器宿主下的 catalog 变化、内存压力实测、Paseo 附件大小上限。

## 2. 发现总表

说明：本 range 六个文件相对 `9298c28` 零改动，**“新引入 vs 基线已有”一列全部是“基线已有”**，括号内注明上轮是否已报。

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| BM-01 | P2 | `mcp-gateway.js:547-550`；`mcp-http.js:484-487`、`:132-163`；`mcp-stdio.js:360-363`、`:281-299` | 用户取消回合（`exec.signal` abort）时 MCP 调用在途 | 实测（真实 gateway + loopback：信号已 abort、请求未中止、250ms 后成功返回 `SIDE_EFFECT_COMPLETED`） | 基线已有；上轮 BR-06 **未修复** |
| BM-02 | P2 | `mcp-gateway.js:517-538`（输出 schema）、`:567-568`（投影） | 服务器返回 `structuredContent`（纯结构或文本+结构） | 实测（`{content:[],structuredContent:{answer:42}}` → `content:""`，42 消失） | 基线已有；上轮 BR-07 **未修复** |
| BM-03 | P2 | `mcp-gateway.js:556-568`、`:277-305` | 服务器返回畸形/任务式 `CallToolResult`：`content` 非数组、`isError` 非布尔、`task` 结果 | 实测（`{content:"hello"}`、`{content:[],isError:"true"}`、`{task:{…}}` 均“成功空内容”） | 基线已有；上轮未单列（BR-07 修法提及 taskSupport） |
| BM-04 | P3 | `transport.js:66`、`:169-176`、`:178-203`；`mcp-stdio.js:160`；`mcp-http.js:161` | 单帧无上限（无换行/超大 payload）；输出写背压或异步 EPIPE | 静态（分帧线性已实测由 `transport-frame-check` 证明；无上限断言；未实测 OOM） | 基线已有；上轮列为风险项 |
| BM-05 | P3 | `mcp-http.js:161-169`、`:186-192`；`mcp-gateway.js:547-550` | MCP HTTP 服务器不可达 / 4xx / 5xx | 实测（拒连得到 `TypeError: fetch failed`，无 server/tool 名；模块头承诺“失败点名 server/tool”不成立） | 基线已有；上轮“错误 body 脱敏”待专项 |
| BM-06 | P3 | `mcp-gateway.js:427`、`:494`；`mcp-http.js:448-481`；`mcp-stdio.js:328-357` | 服务器运行期变更工具目录（`notifications/tools/list_changed`） | 源码推断（gateway 无 `refresh` 调用点；两客户端均丢弃 list_changed） | 基线已有 |
| BM-07 | P3 | `mcp-gateway.js:439-451` | browser 探测工具挂起 / 半可用 | 实测（探测挂 5s + `timeoutMs:1000` → listing 1013ms 后才返回；探测失败不区分“不知道”） | 基线已有（79aa8a6） |
| BM-08 | P3 | `mcp-gateway.js:301-303` | 服务器返回 `audio`/`resource`/未知内容块 | 静态对照（这里 `JSON.stringify` 全量入上下文；上游客户端用占位符） | 基线已有 |
| BM-09 | P3 | `mcp-gateway.js:456-464`、`:499-504` | tool 声明 `outputSchema` / `execution.taskSupport="required"` | 实测（schema 结果无这两字段；task-required 调用不被拒） | 基线已有 |
| BM-10 | P3 | `paseo-system-envelope.js:114-126` | 用户手工发送 `source-server-id=""` 的 versioned `agent-message` 信封 | 实测（与安装的 `@getpaseo/server@0.14.0` 解析器对照：上游拒绝、本端口判 system-injected） | 基线已有 |
| BM-11 | P3 | `paseo-system-envelope.js:210-214`；`mcp-http.js:21` | 维护者按注释行动 | 实测对照（图像 prompt 注释与实现/harness 相反；引用的 `harness/mcp-gateway-check.mjs` 不存在） | 基线已有 |
| BM-12 | P3 | `mcp-http.js:29`、`:148-158`、`:404-406`；`mcp-stdio.js:43`、`:308-316` | 对接严格 MCP 服务器 / 服务端协商到其他版本 | 实测（抓包：initialize、notifications/initialized、tools/list 均无 `mcp-protocol-version` 头）+ MCP 2025-06-18 规范 | 基线已有 |
| BM-13 | P3 | `mcp-http.js:96-117`；`mcp-stdio.js:241-245`、`:268-278` | 服务器发 `ping`/`roots/list`/`sampling/createMessage` 等 server→client 请求 | 静态（HTTP 只写 stderr 不回答；stdio 一律回 -32601，`ping` 也如此） | 基线已有；上轮列为改进方向 |
| BM-14 | P3 | `mcp-gateway.js:238-241`、`:294-297` | 长会话反复截图（screenshot→click→screenshot） | 静态（临时目录只在首次创建、全模块无删除点；`writeFileSync` 在共享进程的 execute 内同步写） | 基线已有（79aa8a6） |
| BM-15 | P3 | `mcp-gateway.js:456-463` | `tools/list` 条目为 `null`/非对象 | 实测（`TypeError: Cannot read properties of null (reading 'name')`，不点名 server/tool） | 基线已有 |
| BM-16 | P3 | `mcp-gateway.js:305` | 工具返回首尾空白敏感文本 | 实测（`"  leading\ntrailing  "` → `"leading\ntrailing"`） | 基线已有 |

## 3. 关键发现详述

### BM-01 · P2 · exec.signal 未贯穿：取消后仍等待并成功返回（上轮 BR-06，未修复）

- 位置：`mcp-gateway.js:547`（`async execute(args)` 不接收 `exec`）、`:550`（`callTool(target, args.arguments ?? {})`）；`mcp-http.js:484-487`（`callTool(name, args)` 无 signal）、`:132-163`（`mcpRequest` 只有内部 timeout controller）；`mcp-stdio.js:360-363`、`:281-299`（pending 只有自己的 timeout）。
- DSH 契约：`@deepseek-ai/dsh-tools/lib/types/index.d.ts:114-132` 明确 “Async work must observe or forward `exec.signal` and settle only after its owned work reaches quiescence”；原生 MCP client 也向 `callTool` 传 `execution.signal`（`dsh-mcp-client/lib/index.js:140-147`）。
- 实测：真实 `apply()` + loopback MCP server。`execute({tool:'delayed'}, {signal})` 发出请求后 abort；server 端 `res.on('close')` **未**提前触发（`closedEarly:false`），250ms 后 gateway promise **成功 resolve** `SIDE_EFFECT_COMPLETED`，`signal.aborted:true`。stdio 侧从 API 形状即可判定（`callTool`/`#request` 都没有 signal 参数）。
- 影响：取消只作用于 DSH 本地工具，不作用于 MCP；Paseo 工具可能在取消后继续建 agent / 发消息 / 点浏览器；结果若含图片块，`projectContent` 会在取消后继续落盘（`:277-306`）。共享进程内这也意味着取消的回合仍占用 pending 直到 60s 超时。
- 修法要点：`execute(args, exec)` 取 `exec.signal`；HTTP 用 `AbortSignal.any([exec.signal, timeout])` 并区分“取消/超时”；stdio 撤销本 caller 的 pending 并发 MCP `notifications/cancelled`（不要杀共享子进程），共享 initialize 不被单个 caller 取消牵连；`projectContent` 写图片前检查 `signal.aborted`。门禁：发出前取消、握手中取消、调用中取消、完成后晚取消、两并发只取消一个、取消后 stdio 仍可继续、超时与取消分类。

### BM-02 · P2 · structuredContent 被丢弃（上轮 BR-07，未修复）

- 位置：`mcp-gateway.js:517-538` 输出 schema 只有 `server/tool/content/images`（`additionalProperties:false`，无结构字段），`:567-568` 只投影 `content` 到文本/图片；`:277-306` 完全忽略 `result.structuredContent`。
- 实测：真实 gateway + loopback，server 返回 `{content:[],structuredContent:{answer:42}}` → gateway 返回 `{server:'fake',tool:'structured',content:'',images:[]}`，42 消失且没有报错。
- 对照：原生 DSH client 的输出 schema 保留 `structuredContent` 并把原值放进 canonical value（`dsh-mcp-client/lib/index.js:199-240`）；Paseo 自己的 MCP server 也会返回该字段（`@getpaseo/server` 的 `paseo-tools.js` 多处 `structuredContent`，`mcp-server.js` 原样透传）。
- 影响：模型看到“成功但空”的工具调用；纯结构结果（含错误结构，如 `browser_no_host` 依赖方）拿不到主结果。Paseo 自家 server 在 `content:[]` 时会补一段摘要文本（`formatStructuredContentForModel`），所以其常规工具损失被部分掩盖；但“结构字段本身”和结构-only server 会直接丢失，且上轮已按 P2 判定。
- 修法：输出 schema 增加 `structuredContent`（宽松 object），render 在文本为空时给 JSON 文本投影；保持与原生 client 的语义一致。门禁：纯文本/纯结构/混合/图片+结构/isError/空对象。

### BM-03 · P2 · CallToolResult 未校验：畸形/任务式结果变“成功空内容”

- 位置：`mcp-gateway.js:556-568` 只用 `result === null || typeof !== 'object'` 与 `isError === true` 两道守卫；`projectContent`（`:277-305`）对非数组 `content`、非字符串 `text` 静默跳过。
- 实测：
  - `{content:"hello"}` → 成功，`content:""`；
  - `{content:[], isError:"true"}`（字符串而非布尔）→ 成功，`content:""`；
  - `{task:{id:"t1",status:"working"}}`（MCP 任务式结果）→ 成功，`content:""`。
- 对照：原生 client 用 `specTypeSchemas.CallToolResult` 校验并抛错（`dsh-mcp-client/lib/index.js:216-245`），且对 `execution.taskSupport === "required"` 显式拒绝。
- 影响：违反本仓库“失败要响亮”的硬约束——模型收到“成功但没输出”，会重复调用或编造结论；任务式工具的结果完全不可见。触发前提是 server 不合规或使用 task 能力（Paseo 0.14 当前两个 server 未观察到），属边界输入，但 gateway 是唯一能兜这层校验的地方。
- 修法：入参按 MCP `CallToolResult` 校验；`content` 非数组或块形状非法要抛；`task` 结果要么实现要么响亮拒绝；`isError` 非布尔视为协议违规。与 BM-02 一起加负向门禁。

### BM-04 · P3 · 传输层资源边界：入站无字节上限、输出背压/异步错误未观察

- 位置：`transport.js:66`（`#partial = []` 无上限）、`:178-203`（线性扫描但每 chunk 都累积到整行）、`:169-176`（`#write` 只看同步异常，忽略 `write()` 返回值，未挂 output `'error'`）、`:114-118`（`flush` 只等回调）。旁路：`mcp-stdio.js:160` 的 readline 行缓冲、`mcp-http.js:161` 的 `response.text()` 均无字节上限。
- 证据：`transport-frame-check.mjs` 20/20 证明线性与逐字节正确，但**没有上限用例**；本 lane 未做内存压力实测（不虚报事故）。上轮已将“输入/输出无字节上限 + 整体预算”列为未修风险项。
- 影响：一个超大/无换行帧或多个大响应会让**服务所有会话的共享桥进程**内存线性增长；stdout 背压时 Node 内部写缓冲同样无上限；stdout 异步 EPIPE 未被监听时可能以未捕获异常结束进程（plugin 侧已有 `process-crash-check` 覆盖，桥侧没有对应检查）。
- 修法：`#partial` 累计字节上限 + 超限响亮失败并丢弃该连接/帧；`#write` 监听 `'error'`、将失败转成 pending 的 reject 而不是等满超时；为 MCP 响应体设上限。门禁：上限边界（刚好/超出）、有上限时大图仍可通过、输出错误时请求快速失败、背压下不丢帧。

### BM-05 · P3 · HTTP 错误不带 server/tool 上下文，且回显响应体片段

- 位置：`mcp-http.js:161-169`（HTTP 错误带 `text.slice(0,200)` 与 `httpBody` 512 字节；网络错误原样抛）、`:186-192`；`mcp-gateway.js:547-550` 不做包装。
- 实测：拒连得到 `{name:'TypeError', message:'fetch failed', cause:'ECONNREFUSED'}`；超时是 `mcp: tools/call timed out after Nms`。两者都没有 server 名或 tool 名。
- 影响：`mcp-gateway.js:23-24` 的模块头承诺“a failed server, unknown tool or MCP-side error throws with the server/tool named”，这一承诺在传输层失败时**不成立**；多 server 配置下模型/日志无法判断是哪个 server 坏了。错误 body 回显 200 字符仍可能带出服务端敏感串（上轮“响应错误 body 尚无通用脱敏”仍待专项）。
- 修法：gateway 在 meta-tool 边界统一包装成 `mcp: <server>/<tool>: <cause>`；HTTP 错误 body 只保留状态码与稳定分类，不回显原文（或按需脱敏）。

### BM-06 · P3 · catalog 缓存没有失效通道（`refresh` 是死路径）

- 位置：`mcp-gateway.js:427`、`:494` 都调用无参 `listTools()`；meta-tool 参数表（`:385-388`、`:471-474`）没有 `refresh`；`mcp-http.js:448-481` 与 `mcp-stdio.js:328-357` 的 `refresh` 选项只对直接调用者可见；两客户端都丢弃服务器通知（HTTP：`mcp-http.js:96-117` 只处理带 id 的响应，notification 被 `continue`；stdio：`mcp-stdio.js:241-245` 直接 return）。
- 触发：server 运行期改工具目录（动态 MCP server、热重载的插件桥）。模型会一直看到旧 catalog，直到桥进程重启才更新；新工具表现为“不存在”，旧工具调用报 “Tool not found”。
- 证据：源码推断（grep 无任何 `refresh: true` 调用点），未在真实动态 server 上实测。
- 修法：给 `mcp_list_tools` 增加 `refresh` 参数并透传；或订阅 `notifications/tools/list_changed` 主动清缓存（HTTP 需要在 SSE 帧里识别通知）。门禁：目录变更后刷新可见。

### BM-07 · P3 · `mcp_list_tools` 与一次真实 browser 探测调用耦合

- 位置：`mcp-gateway.js:439-451`。每次列目录，如果列表里有 `browser_list_tabs`/`browser_tabs`，就额外 `callTool` 一次做宿主探测。
- 实测：探测挂起 5s、`timeoutMs:1000` 时，`mcp_list_tools` 约 1013ms 后才返回（`unavailable:[]`、`tools:1`）；默认 `timeoutMs=60000` 时最坏等 60s。探测失败（超时/进程死）与“宿主存在”在结果里不可区分，也没有任何 stderr 提示。
- 影响：每次 discovery 都可能多一次远程调用并阻塞模型回合；探测失败被静默吞掉。这是 79aa8a6“不再拿写锁”修复引入的成本，属设计取舍（避免把不可用工具当可用），但“探测不了”应有第三种状态而不是与“可用”合并。
- 修法：探测失败返回 `unavailable` 之外的 `probeFailed`/说明，或给探测单独短超时并记日志；`query` 非空时可按需跳过探测。

### BM-08 · P3 · 非文本/音频/资源块被 `JSON.stringify` 全量注入上下文

- 位置：`mcp-gateway.js:301-303`。对 `resource`、`audio`、任何未知类型：`texts.push(JSON.stringify(block))`。
- 对照：原生 client 对 `audio` 用占位符、对 `resource`/`resource_link` 用简短说明，不把 base64 资产放进上下文（`dsh-mcp-client/lib/index.js:355-405`）。
- 触发：任何返回 `audio`（data 是 base64）或带大 payload 的 `resource` 的 MCP server。影响：模型上下文被二进制 base64 挤爆，成本与回合失败风险都高。当前 Paseo/Server Browser 未观察到此类返回，但 gateway 面向任意 server（`servers` 是通用配置）。
- 修法：未知/二进制块用有界占位符（保留类型/mime/uri），不 `JSON.stringify` 原始 data。

### BM-09 · P3 · tool metadata 丢弃 `outputSchema` / `execution.taskSupport`

- 位置：`mcp-gateway.js:456-464`（列表只给 name/description）、`:499-504`（schema 只给 description/inputSchema）。
- 实测：列表里声明 `execution:{taskSupport:'required'}, outputSchema:{…}` 的 tool，经 `mcp_tool_schema` 只剩参数；随后 `mcp_call_tool` 不拒绝 task-required 工具（与 BM-03 的 `{task:…}` 空成功相连）。
- 影响：模型无法知道输出契约与执行模式；task 型工具会“成功空内容”。修法：schema 结果附带 `outputSchema` 摘要与 `execution.taskSupport`（至少把 required 标出来或直接拒绝）。

### BM-10 · P3 · 信封端口漏校验 `source-server-id`，与 Paseo 0.14 解析器分歧（过匹配）

- 位置：`paseo-system-envelope.js:114-126` 的 `agentMessageSource` 只读 `kind`/`source-agent-id`/`source-agent-title`/`event`；Paseo 的 `sourceSchema` 还要求 `source-server-id`（存在时 `z.string().min(1)`，安装的 `@getpaseo/server@0.14.0` `agent-messages/envelope.js`）。
- 实测对照：构造 `<paseo-system version="1" kind="agent-message" source-agent-id="a1" source-server-id="" message-id="m1">\n正文\n</paseo-system>`：
  - `@getpaseo/server` 的 `parseAgentMessage` → `null`；`prepareAgentMessage` 因此**不**把它当保留信封、原样作为用户 prompt 发出（`parseAgentMessages` 返回 null、`isSystemInjectedEnvelope` 为 false）；
  - 桥的 `parsePaseoSystemEnvelope` → `systemInjected:true`。
- 影响：用户手工发送这一形状时，`server.js:1075` 的 `promptSource` 会把它记成 `source.kind='paseo'`：memory capture 跳过、rewind 锚点缺失、时间线渲染成注入上下文而非用户气泡（`paseo-plugin/server/session.ts:305-320` 的 `isUserSource` 分支）. 方向与本地 harness 的“逐字镜像上游”目标相反（是过匹配，不是漏匹配）。
- 修法：`source-server-id` 存在时校验非空（同时可透传 serverId）；补一条上游对照用例；`envelope` 注释里的“0.12.0”与实际 0.14.0 可顺手更新。

### BM-11 · P3 · 两处注释与实现/上游相反（注释不得比实现强）

- `paseo-system-envelope.js:210-214`：“a prompt carrying an image is a user turn by construction” —— 实现只看 text 块、会返回 `kind:'paseo'`；`harness/paseo-system-envelope-check.mjs:129` 明确断言 image+envelope → paseo；Paseo 的 `prepareAgentMessage` 对 agent-message 也正是 `[{text: envelope}, …images]`。这句注释与代码、测试、上游三处都相反，后来者按注释“修正”代码会把带图卡的 agent 消息降级成用户回合。
- `mcp-http.js:21`：注释说由 `harness/mcp-gateway-check.mjs` 驱动，但仓库只有 `mcp-gateway-guard-check.mjs` 与 `mcp-gateway-transport-check.mjs`，不存在该文件名（grep 仅此一处引用）。

### BM-12 · P3 · MCP 握手/版本协商不完整

- 位置：`mcp-http.js:29`、`:148-158`、`:404-406`；`mcp-stdio.js:43`、`:308-316`。客户端固定发 `protocolVersion:"2025-06-18"`，但：① HTTP 后续请求不发 MCP 2025-06-18 规范要求的 `MCP-Protocol-Version` 头；② 不读 initialize 返回的 `protocolVersion`，服务端协商成其他版本也照旧。
- 实测：抓包显示 initialize / notifications/initialized / tools/list 三个请求均无 `mcp-protocol-version`（HTTP）。Paseo 用的 SDK server 对缺头是宽容的（按 initialize 协商值处理），所以当前不坏；对严格实现的 server 会 400。
- 修法：HTTP 在 initialize 成功后所有请求带协商版本头；两客户端校验 initialize result 的版本在支持集内，或至少把服务端版本记录下来。

### BM-13 · P3 · server→client 请求不支持（HTTP 忽略、stdio 一律 -32601）

- 位置：`mcp-http.js:96-117`（识别到带 id 的 method 帧只在 stderr 写一行“cannot be answered”，然后继续找自己的响应）；`mcp-stdio.js:241-245`、`:268-278`（回 `-32601 unsupported`，`ping` 也如此）。
- 影响：MCP 2025-06-18 的 server→client 请求（`ping`、`roots/list`、`sampling/createMessage`、`elicitation/create`）无法被正确应答；严格的 server 可能把客户端判死或等到自己的超时。HTTP 这一侧连 `ping` 都无法答（规范）只能靠日志暴露。上轮已把它列为“通用 server-request 处理”的改进方向，不是新缺陷。
- 修法：`ping` 至少回 `{}`；其余按 -32601 但保留区分；HTTP 若有 POST 回写通道可支持响应（当前设计为每次 POST 一问一答，需评估）。

### BM-14 · P3 · 图片临时目录只增不减 + execute 内同步写

- 位置：`mcp-gateway.js:238-241`（`mkdtempSync` 进程级目录，模块内没有第二次引用/删除），`:294-297`（`writeFileSync` 在工具 execute 的异步函数里同步落盘）。
- 影响：常驻共享桥进程对每次截图的每张图都留一份文件，长会话在 `/tmp` 持续累积；同步写会阻塞事件循环（同进程其他会话的事件也停）。当前没有观测到事故，属资源卫生项。
- 修法：会话/进程退出清理或按数量/大小回收；写文件改异步并保留取消检查（与 BM-01 一起做）。

### BM-15 · P3 · 畸形 `tools/list` 条目不点名（TypeError）

- 位置：`mcp-gateway.js:456-463`（`match`/`map` 直接读 `tool.name`、`tool.description`）。实测 `tools:[null,…]` → `TypeError: Cannot read properties of null (reading 'name')`，失败是响亮的但不点 server/tool，也没有“server violated tools/list”的说明。
- 修法：对每个条目做形状校验，失败时抛 `mcp: <server> returned a malformed tools/list entry at index N`（与 BM-03 的校验风格一致）。

### BM-16 · P3 · 文本被 `trim()`，首尾空白丢失

- 位置：`mcp-gateway.js:305` `texts.join('\n').trim()`。实测工具返回 `"  leading\ntrailing  "` 时模型拿到 `"leading\ntrailing"`。对代码/缩进敏感类 MCP 工具是保真偏差；原生 client 不做 trim。属窄显示/数据保真项。

## 4. 行为正确、不应误判为缺陷的部分（本轮复核）

- **入站分帧**：`transport.js:178-203` 已是线性 + 逐字节正确（`transport-frame-check` 20 MiB/随机分块/旧实现 oracle 全过）；`\r\n`、空行、残行、畸形行的既有语义都被钉住。不要“顺手”重写。
- **HTTP 会话恢复**：`mcp-http.js:347-394` 的 epoch/disown 逻辑正确：并发的 404 只清一次、旧 epoch 的迟到响应不能覆盖新会话、`listTools` 跨页检测 epoch；空 body 不再当空目录、`tools/list` 无数组不再缓存空值、`MAX_TOOL_PAGES=100` 有界。持久 404 场景本 lane 实测是**响亮失败 + 下一次调用重建**，不是死循环。
- **stdio 客户端**：环境用 `scrubbedParentEnv()` + 配置覆盖；非 JSON stdout 行丢弃（Playwright 类 server 需要）；退出/错误会 reject 所有 pending 并让后续调用立即失败（不悬挂、不重启死进程，这是有意边界且已有回归）；`dispose()` 关 stdin→SIGTERM→SIGKILL 阶梯且幂等；缓存命中前有 `#assertUsable`，不会拿死连接的 catalog 回答案。
- **gateway 参数守卫**：`normalizeToolName`（NFKC→NFD→去组合符→白名单→小写）与 folded-call 识别覆盖了真实踩坑的两种模型错误形状；`transportOf` 对 both/neither/typo 都点名；`GATEWAY_TOOL_KEYS` 把 `archive_subagents` 也算作本进程工具。70/70 用例通过。
- **图片路径安全**：`pathSegment` 只留 `[A-Za-z0-9_-]` 且截断，模型控制的 tool 名不能目录穿越；`mkdtempSync` 目录默认 0700；每进程序列避免跨调用覆盖（`mcp-gateway.js:230`、`:263-266`）。
- **信封主体**：12 个对照用例中 11 个与安装的 `@getpaseo/server@0.14.0` 一致（legacy/versioned、user-message、重复属性、非法 event、原始 markup、title 空值都对），仅 BM-10 的空 `source-server-id` 分歧；`promptSource` 只把 systemInjected 映射为 `paseo`、user-message 保持 user，方向正确。
- **审批**：`approval.js` 与 DSH waterfall 一致（只对 owned session 认领、`allowed-once` 是唯一正向、超时→unavailable、撤回通知与 `timedOut` 关联、畸形答复不放过），`p003-bridge-check.mjs` 10 项全过；本 lane 未发现新问题。
- **失败响亮**：MCP `isError` 结果被抛成工具失败、空 body/无 result/无 tool 数组都命名失败、gateway 对未知 server 点名——这些方向是对的，不要在修 BM-01/02/03 时回退。

## 5. 有意边界（不登记为缺陷，避免重复发明）

- stdio 子进程死后**不自动重启**：注释与 `mcp-stdio-check` 均将其定为有意行为（防止坏二进制无限重启），错误是响亮的（每次调用都点名）。可作为运维边界记录：一次崩溃后该 server 直到桥重启都不可用。
- HTTP SSE 先 `response.text()` 等 EOF、不消费 GET 流：2026-10-29 已登记暂缓，本轮不重复登记（但 BM-04 的字节上限在它上面同样适用）。
- `mcp_list_tools` 的 `total` 是总数、`tools` 是过滤结果：`query` 场景下渲染头部写“N tool(s)”可能让模型误以为列表完整，属展示取舍，未单列。
- `cacheTools` 默认真：是 gateway 省上下文的核心设计，不当作缺陷；问题只在“失效通道不存在”（BM-06）。

## 6. 测试覆盖评估

- 现有覆盖质量好的一面：全部断言打在协议/行为层（真实模块、真实分帧、loopback、上游对照），不是字符串快照；`mcp-gateway-guard-check` 驱动真实 `apply()+defineTool` 注册路径而不是私有函数；`transport-frame-check` 用旧实现当 oracle；`mcp-stdio-check` 覆盖握手顺序、非 JSON 行、超时、进程退出、dispose；`p003-bridge-check` 覆盖审批的取消/超时/畸形答复。
- 明确缺口（与本报告 P2/P3 一一对应）：
  1. 没有任何 `exec.signal` 用例（预发送/握手中/在途/晚到/并发单取消）——BM-01；
  2. 没有 `structuredContent` 与畸形 `CallToolResult` 用例——BM-02/BM-03；
  3. 没有传输层上限/背压/输出错误用例——BM-04；
  4. 没有 catalog 变更/`refresh`/list_changed 用例——BM-06/BM-09；
  5. 没有 server→client 请求用例（`ping` 等）——BM-13；
  6. 信封对照缺 `source-server-id` 空值/带值两个用例，且没有“与上游 parser 差分”的 harness——BM-10。
- 注意：`harness/*` 全绿**不能**作为本 lane 的“健康证明”；上述六类是目前判据结构上抓不到的。

## 7. 未验证项（不当作结论）

- 未跑真实 DSH 回合/daemon 的取消路径：BM-01 的影响面（远端副作用继续多久、图片是否真的在取消后落盘）是按代码路径推断，已实测到“调用在取消后仍成功返回”，但未观测真实 Paseo 工具副作用。
- 未做内存压力实测：BM-04 是静态风险，未测出 OOM/崩溃，不虚报事故。
- 未验证 Paseo/浏览器桥真实 server 是否发送 server→client 请求（BM-13）或运行期修改 catalog（BM-06）。
- 未验证 Paseo 客户端附件大小上限（决定 BM-04 触发概率）；`mcp_list_tools` 探测失败的第三态（BM-07）在真实浏览器宿主半可用时未实测。
- 未验证 Patched host / 移动端展示：`source.kind` 错分在 Paseo App 上的最终呈现未在真机核对（BM-10 只验证到桥的 source 选择与插件 `isUserSource` 分支）。

## 8. 健康度评分

| 维度 | 分数（1-5） | 依据 |
|---|---|---|
| 正确性 | 3 | 主路径正确；BM-01/02/03 三个数据/语义缺口均有实测反例 |
| 健壮性 | 3 | 分帧、会话恢复、死进程排水做得好；但取消、无上限缓冲、探测失败第三态缺 |
| 可维护性 | 3 | 注释密度高、意图写得好；两处注释与实现/上游相反，且并行常量/文档引用有漂移 |
| 契约一致性 | 2 | DSH execute 契约未遵守（signal）；MCP 规范（版本头、server→client、结果 schema）只实现子集；信封端口与上游解析器有一处分歧 |
| 性能 | 3 | 分帧已线性化；但同步图片写、每页独立超时、listing 额外探测调用、无响应上限 |
| 安全 | 3 | 图片路径/环境清洗/0700 目录做得好；错误 body 回显、无界输入、二进制块进上下文是残留面 |
| 测试覆盖 | 3 | 6 个 harness 210 项全绿且判据扎实；上面 6 类缺口结构上抓不到 |

**综合：2.9 / 5（四舍五入记 3）。** 一句总评：*“传输/分帧与守卫层已经是‘有判据的工程’，但 MCP 代理层仍是‘能跑通的代理’——取消、结果保真和协议校验三件事没闭环，不能算健康。”*

## 9. Top 问题（≤5）

1. **BM-01（P2）** 取消不贯穿：`exec.signal` 被 gateway 完全丢弃，取消后 MCP 调用继续执行并成功返回（上轮 BR-06，未修复）。
2. **BM-02（P2）** `structuredContent` 丢失：结构-only 结果变“成功空内容”（上轮 BR-07，未修复）。
3. **BM-03（P2）** `CallToolResult` 未校验：畸形/任务式结果静默成空成功，违反“失败要响亮”。
4. **BM-04（P3，但影响全进程）** 入站帧无字节上限 + 输出背压/异步错误未观察；共享桥进程一次异常输入可影响所有会话。
5. **BM-10（P3）** 信封端口漏校验 `source-server-id`：用户手工输入特定信封会把用户消息记成系统注入（memory/rewind/时间线三处受影响）。

## 10. 建议优先级

1. **先修 BM-01 + BM-02 + BM-03（一个批次、三组会红的负向门禁）**：这是 MCP 代理层的契约三件套，且都已在 `dsh-tools`/原生 client 里有权威参考实现；修完前不建议再扩 MCP 代理能力或给 gateway 增加新 server。
2. **随后做 BM-04（传输预算）+ BM-06/BM-07（catalog 失效与探测第三态）**：都是共享进程级/模型回合级成本，先加判据再谈调参。
3. **协议卫生（BM-12/13/09 + BM-08）**：与真实 Paseo server 的兼容性风险低，但作为通用 gateway 的对外契约需要补齐；建议在新增 MCP server 类型前完成。
4. **BM-05/10/11/15/16（错误上下文、信封端口、注释漂移、白空格）**：可随手带上，但 BM-10/11 建议放进下一次信封相关改动（它们会误导后续维护者）。
5. **BM-14** 随手清理（图片目录回收 + 异步写），可与 BM-01 的“写前检查取消”一起做。

## 11. 是否有阻断性健康问题

**没有 P0/P1，也没有阻断当前主路径的 P2。** Paseo HTTP（stateless）路径的 discovery/schema/call 与错误回执仍可用，现有回归全绿；BM-01/02/03 是**契约级数据问题**（取消语义、结构结果、失败语义），应在下一次 MCP 相关修复批次里解决，并在扩展 MCP 代理面之前完成，但不是“当前版本不可用”的阻断问题。
