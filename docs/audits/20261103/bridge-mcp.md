# bridge-mcp lane 审查报告（dsh-bridge MCP 网关与传输层）

- 审查基线：`0c82df5`（main；工作区仅有未跟踪的 `V1.txt`/`v1.txt`）
- 上一轮：`docs/FULL-AUDIT-20261102.md` §3.2（BR-06/BR-07/BR-08）、§4.2（BM-03）、§10.1 `p3-bridge-mcp`；上轮本 lane 报告 `docs/audits/20261102/bridge-mcp.md`（基线 `2f71225`）
- 本 lane 范围（全文逐行）：`dsh-bridge/lib/mcp-gateway.js`(682)、`mcp-http.js`(549)、`mcp-stdio.js`(467)、`paseo-system-envelope.js`(235)、`approval.js`(39)
- 改动归属：本 lane 自 `2f71225` 以来只有 `6394809` 一处改动（`mcp-gateway.js`/`mcp-http.js`/`mcp-stdio.js`）；`paseo-system-envelope.js`、`approval.js` 未改
- 只读声明：未修改任何 tracked 文件（本报告除外），未做 git 写操作；未启动真实 daemon/profile/模型；探针全部在 `/tmp/bmp/`（不提交）
- ID 说明：**本报告 BM-01 起为本轮重编**，括号内注上轮对应编号，避免与上轮同号条目混淆

## 0. 结论先行

- **修复轮三件套已落地且经独立复现**：BR-06（`exec.signal` 贯穿）、BR-07/BM-02（`structuredContent` 保留）、BM-03（`CallToolResult` 校验）全部通过我自己的 loopback/stdio 探针（12/12 判定项、10/10 判定项），且不是「harness 手工塞 exec 造成的假绿」——已核对真实 `dsh-tools` 运行时确实以 `tool.execute(exec.arguments, exec)` 调用、`exec.signal` 是真实字段。**未发现修复轮引入的新回归。**
- **P0/P1/P2 = 0/0/0。** 本 lane 上一轮的 3 个 P2 已全部关闭；本轮**新记录** 5 条 P3（基线已有、上轮未记录/未单列），加上轮已记录、本轮独立复核仍成立的 13 条 P3，共 **18 条 P3**。
- 最值得先处理的三条 P3（都不阻断主路径）：
  1. `mcp_list_tools` 每次列目录都额外做一次真实 browser 探测，最坏阻塞 `timeoutMs`（默认 60s），且探测失败与「宿主存在」不可区分（`mcp-gateway.js:508-523`）；
  2. 该探测把**任意** `isError` 结果都当作「无浏览器宿主」，一次无关失败会把全部 `browser_*` 工具标成不可用（`mcp-http.js:285-290` + `mcp-gateway.js:525`）；
  3. 信封端口漏校验 `source-server-id`：与安装的 `@getpaseo/server@0.14.0` 解析器分歧，用户手工输入该形状会被记成系统注入（`paseo-system-envelope.js:114-126`）。
- 一句话总评：**取消语义与结果保真这两块欠账已经还清，gateway 从「能跑通的代理」升级为「有契约的代理」；剩下的都是协议卫生、探测语义与资源边界，不影响当前 Paseo HTTP 主路径。**

## 1. 范围与方法

逐行通读五个文件，并追调用链：`dsh-bridge/lib/server.js`（`mountMcp` per-agent 挂载、`promptSource` 消费点 `:1199`）、`paseo-plugin/server/dsh-process.ts`（`mcpEntries` 白名单/SSE 拒绝、`paseo/permission` 帧形状）、`dsh-bridge/lib/transport.js`（`notify`/`request`/未知 id 响应）、安装的 DSH 运行时（`dsh-tools`、`dsh-mcp-client`、`@modelcontextprotocol/client@2.2.0`）、安装的 `@getpaseo/cli@0.14.0` 内置 `@getpaseo/server` 信封解析器。

### 1.1 复跑的仓库 harness（全部纯离线/loopback，记录 exit code）

| 命令 | 结果 |
|---|---|
| `node harness/mcp-http-check.mjs` | 60/60 passed，exit 0 |
| `node harness/mcp-stdio-check.mjs` | 28/28 passed，exit 0 |
| `node harness/mcp-gateway-guard-check.mjs` | 70/70 passed，exit 0 |
| `node harness/mcp-gateway-transport-check.mjs` | 10/10 passed，exit 0 |
| `node harness/mcp-gateway-call-check.mjs` | 17/17 passed，exit 0 |
| `node harness/paseo-system-envelope-check.mjs` | 33/33 passed，exit 0 |
| `node harness/image-host-path-check.mjs`（BR-08 核查，非本 lane 文件） | 46/46 passed，exit 0 |
| `node harness/p003-bridge-check.mjs`（approval 接线） | 10 passed，exit 0 |
| `node harness/bridge-assets-check.mjs`（内嵌桥新鲜度） | 2/2 passed，exit 0 |

合计本 lane 直接相关 185 项 MCP 检查 + 33 项信封检查全绿。**harness 全绿不作为健康证明**：其中 `mcp-gateway-call-check` 的 `exec` 是脚本自造的，所以我另外核对了真实运行时签名（见 §4.1）。

### 1.2 自写临时探针（`/tmp/bmp/`，全部驱动真实模块，不写仓库）

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `probe-http.mjs` | 真实 `apply()` + loopback HTTP：structuredContent、CallToolResult 负例、取消/预取消、空结果/空文本/空白/audio/非法 base64、探测误报、畸形目录、query、metadata、SSE 边角、`pickResult` id 撞车 | 12/12 判定通过，exit 0；另有 19 条 INFO 记录 |
| `probe-http2.mjs` | 请求头抓包、协商版本、会话 404 恢复、`MAX_TOOL_PAGES`、`tools/list` 取消与缓存污染 | exit 0 |
| `probe-stdio.mjs` + `fake-stdio.mjs` | 真实 `McpStdioClient` + 脚本化 stdio server：取消与 `notifications/cancelled`、批处理数组帧、server→client 请求/id 撞车、`dispose`、死进程不重启、错误文案 | 10/10 判定通过，exit 0 |
| `probe-envelope.mjs` | 13 个信封形状与安装的 `@getpaseo/server@0.14.0` `parseAgentMessage`/`isSystemInjectedEnvelope` 逐用例对照 | 12/13 一致；唯一分歧见 BM-03 |
| `probe-latency.mjs` | browser 探测挂起时 `mcp_list_tools` 的阻塞时长与第三态 | 实测 1039ms（timeoutMs=1000），`unavailable=[]` |
| `mcp-schema-probe2.mjs` | 用安装的 `@modelcontextprotocol/client@2.2.0` `specTypeSchemas.CallToolResult` 校验各形状 | 见 §4.2 |

证据等级：【实测】= 有可复现命令/探针 + exit code 或输出片段；【源码推断】= 逐行读码/上游对照，未跑副作用；【文档】= 仓库文档声明。

## 2. 健康度评分

| 维度 | 分数（1-5） | 依据 |
|---|---|---|
| 正确性 | 4 | 取消、结果保真、结果校验三条 P2 已修并有独立反例；主路径（HTTP/stdio、三工具、会话恢复）正确；残留是 P3 保真项 |
| 健壮性 | 3 | 取消贯穿、会话 404 恢复、`MAX_TOOL_PAGES`、`dispose` 阶梯、死进程不重启都做对了；但 MCP 响应体/行无字节上限、探测第三态缺失、stdio 批处理帧被静默丢弃 |
| 可维护性 | 3 | 注释密度与意图记录非常好；但两处注释与实现/上游相反，一处引用不存在的 harness 文件名 |
| 契约一致性 | 4 | DSH `exec.signal` 契约已满足；MCP `CallToolResult` 已按声明版本校验；仍缺 `MCP-Protocol-Version` 头、server→client 请求处理、`outputSchema`/`taskSupport` 暴露 |
| 性能 | 3 | catalog 缓存与分页有界；但每次 listing 额外一次探测调用（最坏 60s）、图片同步写、无响应体上限 |
| 安全 | 4 | 图片路径白名单化 + mkdtemp 0700 + `scrubbedParentEnv` + 配置/头不进错误文案；残留：stdio 错误文案含完整命令行（args 可能含凭据）、HTTP 错误回显响应体片段、无界输入 |
| 测试覆盖 | 4 | 185 项 MCP + 33 项信封 + 10 项审批 + 46 项图片；缺口集中在 server→client、批处理/多行 SSE、探测第三态、非法 base64、命令行泄露（均与本轮 P3 一一对应） |

**综合：3.6 / 5（四舍五入记 4）。** 与上轮 2.9 相比的提升全部来自修复轮：P2 清零且带负向门禁。之所以不给 4.5+：18 条 P3 里有两类会在真实环境变成「模型回合变慢/能力被误报」的体验问题（BM-01/BM-02），只是尚未观测到事故。

## 3. 发现列表

说明：`归属` = **新引入**（`6394809` 修复轮引入）或 **基线已有**（`2f71225` 及更早，括号内注上轮编号）。本轮**没有新引入发现**。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| BM-01 | P3 | `mcp-gateway.js:496,508-523,525`；`mcp-http.js:272-295` | 每次 `mcp_list_tools` 且目录里有 browser 探测工具 | 【实测】探测挂起 → listing 阻塞 1039ms（timeoutMs=1000；默认 60000）后返回 `unavailable=[]` | 基线已有（上轮 BM-07） | listing 与一次真实 browser 探测耦合；最坏阻塞 `timeoutMs`；探测失败与「宿主存在」不可区分 |
| BM-02 | P3 | `mcp-http.js:285-290`；`mcp-gateway.js:525` | 探测工具返回**非宿主原因**的 `isError`（如权限/面板忙） | 【实测】`isError:"permission denied: browser panel busy"` → `unavailable=["browser_tabs","browser_click"]` | 基线已有（上轮 BM-07 相邻，未单列） | 任意 `isError` 都被当作「无浏览器宿主」，全部 `browser_*` 工具被误标不可用 |
| BM-03 | P3 | `paseo-system-envelope.js:114-126`（无 `source-server-id`）；`:202-205` | 用户手工发送 `kind="agent-message"` 且 `source-server-id=""` 的 versioned 信封 | 【实测】与安装 `@getpaseo/server@0.14.0` 对照：上游 `parseAgentMessage` → `null`（不重包，原样发出），本端口 → `systemInjected:true` | 基线已有（上轮 BM-10） | 信封端口漏校验 `source-server-id`（存在时须非空），过匹配导致用户回合被记成 `paseo` 注入 |
| BM-04 | P3 | `mcp-http.js:509-542`；`mcp-stdio.js:405-434`；`mcp-gateway.js:496,570`；丢弃点 `mcp-http.js:96-108`、`mcp-stdio.js:276-280` | 服务器运行期修改工具目录（`notifications/tools/list_changed`） | 【源码推断】gateway 无任何 `refresh:true` 调用点；两客户端都丢弃 list_changed 通知 | 基线已有（上轮 BM-06） | catalog 缓存无失效通道：新工具表现为「不存在」，直到会话丢失/进程重启 |
| BM-05 | P3 | `mcp-http.js:180-188,206-215`；`mcp-gateway.js:647-657` 不包装 | MCP HTTP 服务器不可达 / 4xx / 5xx / 网络错误 | 【实测】拒连得到裸 `"fetch failed"`（无 `mcp:`、无方法、无 server/tool 名）；HTTP 错误带响应体前 200 字符 | 基线已有（上轮 BM-05） | 传输层失败不点名 server/tool，多 server 配置下模型/日志无法定位；错误 body 片段回显 |
| BM-06 | P3 | `mcp-http.js:29,163-173,466-467`；`mcp-stdio.js:43,387` | 对接严格 MCP 服务器；或服务端协商到其他协议版本 | 【实测】抓包：initialize / notifications/initialized / tools/list / tools/call 均无 `mcp-protocol-version` 头；服务端答 `2025-11-25` 被忽略 | 基线已有（上轮 BM-12） | 后续 HTTP 请求缺 MCP 2025-06-18 规范要求的 `MCP-Protocol-Version` 头；initialize 返回的协商版本不校验、不记录 |
| BM-07 | P3 | `mcp-http.js:100-108`；`mcp-stdio.js:276-280,303-313` | 服务器发 `ping`/`roots/list`/`sampling/createMessage` 等 server→client 请求 | 【实测】stdio 对 id 99 的 `ping` 回 `-32601 unsupported ping`；HTTP 侧只写 stderr 不回答（同一响应体内 id 撞车不劫持调用，见 §4.2） | 基线已有（上轮 BM-13） | server→client 请求不支持；`ping` 也不回空结果，严格 server 可能等到自己超时 |
| BM-08 | P3 | `mcp-gateway.js:307-309` | 工具返回 `audio`/`resource`/未知内容块 | 【实测】`audio` 块（base64）被整段 `JSON.stringify` 进 `content` 文本 | 基线已有（上轮 BM-08） | 二进制/资源块全量进模型上下文，成本与回合失败风险 |
| BM-09 | P3 | `mcp-gateway.js:576-581` | 工具声明 `outputSchema` / `execution.taskSupport` | 【实测】`mcp_tool_schema` 只返回 name/description/parameters，两字段消失 | 基线已有（上轮 BM-09） | 模型无法知道输出契约与任务执行模式 |
| BM-10 | P3 | `mcp-http.js:176`；`mcp-stdio.js:195` | 服务器返回超大响应体 / 超长单行 | 【源码推断】`response.text()` 与 `createInterface` 行缓冲均无字节上限（桥自身入站分帧已有 256MB 上限，见 §4.2） | 基线已有（上轮 BM-04 的 MCP 侧） | 共享 DSH 子进程可被一个异常 MCP 响应拖到内存线性增长 |
| BM-11 | P3 | `mcp-gateway.js:509,527-529,533-536` | `tools/list` 条目为 `null`/非对象 | 【实测】`tools:[null,…]` → `TypeError: Cannot read properties of null (reading 'name')` | 基线已有（上轮 BM-15） | 畸形目录条目失败响亮但不点名 server，也没有「server 违反 tools/list」的说明 |
| BM-12 | P3 | `mcp-gateway.js:230,238-241,300-303` | 长会话反复截图 | 【源码推断】模块级 mkdtemp 目录只建不删；`writeFileSync` 在 `execute` 内同步写 | 基线已有（上轮 BM-14） | 图片临时目录只增不减；同步写阻塞共享进程事件循环 |
| BM-13 | P3 | `mcp-gateway.js:311` | 工具返回首尾空白敏感文本 | 【实测】`"  leading\ntrailing  "` → `"leading\ntrailing"` | 基线已有（上轮 BM-16） | `texts.join('\n').trim()` 丢首尾空白（原生 client 不 trim） |
| BM-14 | P3 | `mcp-stdio.js:248-294`（`:260` 类型判断、`:281` id 判断） | stdio server 用 JSON-RPC 批处理数组回答 | 【实测】数组帧被静默丢弃 → `tools/call timed out after 400ms` | 基线已有（上轮未记录） | 批处理数组帧被当作「无 id 帧」丢弃，最终表现为超时而不是点名协议违规（HTTP 侧反而支持数组） |
| BM-15 | P3 | `mcp-http.js:48-62`（`:50-58`） | SSE 响应把一条 JSON-RPC 消息拆成多个 `data:` 行 | 【实测】`data: {"jsonrpc":"2.0",\ndata: "id":1,…}` → `mcp: unparseable SSE data frame` | 基线已有（上轮未记录） | 只按行解析，未按 SSE 规范拼接多行 `data:`；合规但少见的 server 会直接失败 |
| BM-16 | P3 | `mcp-stdio.js:162`；错误文案 `:243,290,354,361,412,419` | stdio server 启动失败/退出/超时，且配置了 `args` | 【实测】args 含 `--api-key=TOPSECRET-XYZ` 时错误文案为 `mcp: /usr/bin/node -e … --api-key=TOPSECRET-XYZ: initialize failed: …` | 基线已有（上轮未记录） | 错误文案把完整命令行（含 args）写进模型可见的 tool error 与日志；凭据形状的 args 会外泄 |
| BM-17 | P3 | `mcp-gateway.js:288-305`（`:303`） | 服务器返回非法 base64 的 image 块 | 【实测】`data:"!!!not-base64!!!"` → 写出 7 字节损坏文件、调用报成功、模型拿到路径 | 基线已有（上轮未记录） | 未校验 base64 就落盘，损坏图片要到 `read_image` 才暴露 |
| BM-18 | P3 | `paseo-system-envelope.js:208-214`；`mcp-http.js:21` | 维护者按注释行动 | 【实测】`promptSource([legacy, image])` → `{kind:'paseo'}`，与注释「a prompt carrying an image is a user turn by construction」相反；`harness/mcp-gateway-check.mjs` 不存在 | 基线已有（上轮 BM-11） | 两处注释与实现/上游相反；引用不存在的 harness 文件名 |

### 3.1 详述

#### BM-01 · P3 · `mcp_list_tools` 与一次真实 browser 探测耦合（上轮 BM-07）

- 位置：`mcp-gateway.js:508-523`（探测调用）、`:496`（先列目录）、`:525`（标记 unavailable）；探测判定 `mcp-http.js:272-295`。
- 实测：假 server 的 `browser_tabs` 永不回答、`timeoutMs=1000` → `mcp_list_tools` **1039ms** 后才返回，`unavailable=[]`、`total=2`；正常探测 4ms。默认 `timeoutMs=60000` 时最坏同数量级（60s）。
- 影响：每次 discovery 都可能把模型回合拖到超时上限；探测超时/进程死与「宿主在线」在结果上不可区分（都是 `unavailable:[]`），且无 stderr 提示——正是 gateway 注释里说要避免的「dead probe that looks alive」。
- 修法：给探测单独短超时（如 3-5s）+ 结果第三态（`probeFailed` 或说明）；`query` 非空时跳过探测；探测失败记一条 stderr。

#### BM-02 · P3 · 任意 `isError` 被当作「无浏览器宿主」

- 位置：`mcp-http.js:285-290`（`result?.isError === true` 直接取第一个 text 块作为 hostGap）；`mcp-gateway.js:525` → `unavailableBrowserTools`。
- 实测：探测返回 `{isError:true, content:[{type:'text',text:'permission denied: browser panel busy'}]}` → `unavailable=["browser_tabs","browser_click"]`（全部 `browser_*`）。
- 影响：一次与宿主无关的失败（权限、面板被占用、参数错误）会让模型以为所有浏览器工具不可用，属于能力误报；`isError` 是协议级信号但**不能**单独证明「无宿主」。
- 修法：`isError` 分支保留原文案作为「探测失败」而非「无宿主」；只有识别到宿主缺失特征（`browser_no_host` 结构或本地化固定文案）才标 `unavailable`；否则给第三态。

#### BM-03 · P3 · 信封端口漏校验 `source-server-id`（上轮 BM-10）

- 位置：`paseo-system-envelope.js:114-126`（`agentMessageSource` 只读 kind/source-agent-id/source-agent-title/event）；`:202-205`（`isPaseoSystemEnvelope`）。
- 上游依据：安装的 `@getpaseo/server@0.14.0` `agent-messages/envelope.js` 的 `sourceSchema` 为 `serverId: z.string().min(1).optional()`；空串使 `safeParse` 失败 → `parseAgentMessage` 返回 `null`。
- 实测（`probe-envelope.mjs`）：13 个形状中 12 个与上游一致（legacy 用上游 `isSystemInjectedEnvelope` 对照一致）；唯一分歧是 `source-server-id=""`：本端口 `systemInjected:true`，上游 `null`。
- 影响链：上游 `prepareAgentMessage` 因此不把该 prompt 当保留信封（不重包成 `user-message`），原样作为用户 prompt 发出；桥的 `promptSource`（`server.js:1199`）判成 `paseo` → memory capture 跳过该回合、rewind 锚点缺失、时间线渲染成注入上下文。触发需要用户手工输入该形状，属窄触发，故记 P3。
- 修法：`source-server-id` 存在时校验非空（并顺带透传 `serverId`）；补一条与上游 parser 的差分用例。

#### BM-04 · P3 · catalog 缓存没有失效通道（上轮 BM-06）

- 位置：`mcp-http.js:509-542`、`mcp-stdio.js:405-434` 的缓存与 `refresh` 选项；丢弃通知：`mcp-http.js:96-108`（带 method 的帧只写 stderr）、`mcp-stdio.js:276-280`（无 id 直接 return）；gateway 调用点 `mcp-gateway.js:496,570` 均无 `refresh`。
- 源码推断：`grep refresh mcp-gateway.js` 无命中；`notifications/tools/list_changed` 无处理。
- 影响：服务器运行期改目录（热重载插件桥、动态 MCP server）后，模型一直看到旧 catalog，直到会话丢失或桥进程重启；新工具表现为「不存在」，旧工具调用报 Tool not found。当前 Paseo 两个 server 的目录静态，故 P3。
- 修法：`mcp_list_tools` 增加 `refresh` 参数并透传；或识别 list_changed 主动清缓存（HTTP 需在 SSE 帧里识别通知）。

#### BM-05 · P3 · HTTP 传输失败不点名 server/tool（上轮 BM-05）

- 位置：`mcp-http.js:180-188`（HTTP 状态错误，`text.slice(0,200)` 回显）、`:206-215`（网络错误原样抛）；`mcp-gateway.js:647-657` 不包装传输错误。
- 实测：拒连得到 `TypeError: fetch failed`（裸消息，无 `mcp:` 前缀、无方法名、无 server/tool 名）；HTTP 500 得到 `mcp: tools/call failed with HTTP 500: <body 前 200 字>`。
- 影响：`mcp-gateway.js:23-24` 模块头承诺「a failed server, unknown tool or MCP-side error throws with the server/tool named」在传输层失败时不成立；多 server 配置下无法定位，且响应体片段可能带服务端敏感串。
- 修法：gateway 在 meta-tool 边界统一包装为 `mcp: <server>/<tool>: <cause>`；HTTP 错误 body 只保留状态码与稳定分类（或脱敏）。

#### BM-06 · P3 · MCP 协议版本头/协商版本（上轮 BM-12）

- 位置：`mcp-http.js:29`（固定声明 `2025-06-18`）、`:163-173`（请求头只有 content-type/accept/mcp-session-id + 配置头）、`:466-467`（initialize 参数）；`mcp-stdio.js:43,387`。
- 实测（抓包）：initialize、notifications/initialized、tools/list、tools/call 四个请求均无 `mcp-protocol-version`；服务端在 initialize 回 `2025-11-25` 时客户端照旧（无校验、无记录）。
- 影响：MCP 2025-06-18 规范要求 initialize 之后所有 HTTP 请求带 `MCP-Protocol-Version` 头；对严格实现的 server 会 400（当前 Paseo 用的 SDK server 宽容，所以不坏）。版本协商被忽略还意味着 server 用新版本形状（如 `structuredContent` 更宽松的类型、task 结果）时，gateway 的按旧版校验会报「协议违规」。
- 修法：记录 initialize 返回的版本并在后续请求带该头；对不在支持集的版本显式降级/报错。

#### BM-07 · P3 · server→client 请求不支持（上轮 BM-13）

- 位置：`mcp-http.js:100-108`（识别到带 id 的 method 帧只写 stderr）；`mcp-stdio.js:276-280,303-313`（一律回 `-32601`）。
- 实测：stdio server 在握手后发 `{"id":99,"method":"ping"}` → 客户端回 `{"id":99,"error":{"code":-32601,"message":"unsupported ping"}}`；HTTP 侧同形状帧只产生一行 stderr，响应仍正确解析（`pickResult` 不把带 method 的帧当答案，id 撞车不劫持调用，见 §4.2）。
- 影响：`ping`/`roots/list`/`sampling/createMessage`/`elicitation/create` 无法正确应答；严格的 server 可能判客户端已死或等到自己超时。
- 修法：`ping` 至少回 `{}`；其余按 `-32601` 但区分「不支持的方法」；HTTP 侧受「一次 POST 一问一答」设计限制，可先明确记录为边界。

#### BM-08 · P3 · 非文本块全量 `JSON.stringify` 进上下文（上轮 BM-08）

- 位置：`mcp-gateway.js:307-309`。
- 实测：`{type:'audio', data:<1x1 PNG base64>, mimeType:'audio/wav'}` → `content` 文本为整段 JSON（含 base64）。
- 对照：原生 `dsh-mcp-client` 对 `audio` 用占位符、对 `resource`/`resource_link` 用简短说明，不把二进制资产放进上下文。
- 修法：未知/二进制块用有界占位符（保留 type/mime/uri），不 stringify 原始 `data`。

#### BM-09 · P3 · tool metadata 丢弃 `outputSchema`/`execution.taskSupport`（上轮 BM-09）

- 位置：`mcp-gateway.js:576-581`（`mcp_tool_schema` 只回 name/description/parameters）。
- 实测：目录里声明 `outputSchema` 与 `execution:{taskSupport:'required'}` 的工具，schema 结果只剩 `parameters`；随后调用不会拒绝 task-required 工具（若 server 回 `{task:…}` 才由 BM-03 的校验响亮拒绝）。
- 修法：schema 结果附带 `outputSchema` 与 `taskSupport`（至少把 `required` 标出或直接拒绝调用）。

#### BM-10 · P3 · MCP 响应/单行无字节上限（上轮 BM-04 的 MCP 侧）

- 位置：`mcp-http.js:176`（`await response.text()` 整包读入）、`mcp-stdio.js:195`（`createInterface` 行缓冲无上限）。
- 旁证：桥自身的入站分帧已在修复轮加上 `maxPendingBytes`（`transport.js` 的 `#reportOverflow`），说明仓库已认可「共享进程无界输入是 OOM 风险」；MCP 客户端这两处仍无上限。
- 修法：为 MCP 响应体与 stdio 单行设上限，超限响亮失败（与桥侧同口径）。
- 未验证：未做内存压力实测，不虚报事故。

#### BM-11 · P3 · 畸形 `tools/list` 条目裸 TypeError（上轮 BM-15）

- 位置：`mcp-gateway.js:509`（`names` 用 `tool?.name` 容错）、`:527-529`（query 过滤直接 `tool.name`）、`:533-536`（map 直接读 name/description）。
- 实测：`tools:[null,{name:'ok'}]` → `TypeError: Cannot read properties of null (reading 'name')`（无 server 名、无索引）。
- 修法：逐条目做形状校验，抛 `mcp: <server> returned a malformed tools/list entry at index N`（与 BM-03 校验风格一致）。

#### BM-12 · P3 · 图片临时目录只增不减 + 同步写（上轮 BM-14）

- 位置：`mcp-gateway.js:230`（进程级序号）、`:238-241`（`mkdtempSync` 只建一次）、`:300-303`（`writeFileSync`）。
- 源码推断：模块内无删除点；长会话每次截图留一份文件在 `/tmp/paseo-mcp-images-*`；同步写阻塞同进程其他会话的事件循环。
- 修法：会话/进程退出清理或按数量/大小回收；写文件改异步并保留取消检查。

#### BM-13 · P3 · 文本 `trim()` 丢首尾空白（上轮 BM-16）

- 位置：`mcp-gateway.js:311`。
- 实测：`"  leading\ntrailing  "` → `"leading\ntrailing"`。
- 修法：只把「全空文本」归一为 `''`，不裁剪非空文本的首尾（或仅去尾部单个换行）。

#### BM-14 · P3 · stdio 批处理数组帧被静默丢弃

- 位置：`mcp-stdio.js:248-294`：数组是对象（`:260` 通过），无 `method`（`:276` 不命中），无 `id`（`:281` 直接 return）。
- 实测：fake server 对 `tools/call` 回 `[{"jsonrpc":"2.0","id":N,"result":{…}}]` → `mcp: … tools/call timed out after 400ms`。
- 背景：MCP 2025-03-26 起已移除 JSON-RPC 批处理，合规 server 不应这样回；但 HTTP 客户端 `pickResult` 明确支持数组（注释「batch-shaped servers」），两传输不一致，且静默丢弃违反「失败要响亮」。
- 修法：识别数组帧并对其中 id 匹配的响应正常 resolve（与 HTTP 同语义），或至少 stderr 点名「batch frame ignored」。

#### BM-15 · P3 · SSE 多行 `data:` 帧解析失败

- 位置：`mcp-http.js:48-62`：逐行 `startsWith('data:')` 后各自 `JSON.parse`，`:58` 解析失败即抛。
- 实测：`data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}` → `mcp: unparseable SSE data frame: {"jsonrpc":"2.0",`。
- 背景：SSE 规范允许一个事件的数据跨多个 `data:` 行（用换行拼接），官方 SDK 的 eventsource 解析器就是这样处理的；MCP server 通常不拆行，故 P3。失败是响亮的（不会静默），影响是「与这类 server 无法互通」。
- 修法：按 SSE 事件块聚合（空行分隔）后拼接 `data:` 行再解析；保留现有单行快速路径。

#### BM-16 · P3 · stdio 错误文案包含完整命令行（args 可能含凭据）

- 位置：`mcp-stdio.js:162` 的 `#label = [command, ...args].join(' ')`；所有错误文案都用它（如 `:185,228,243,290,354,361,412,419`）。
- 实测：args 含 `--api-key=TOPSECRET-XYZ` 时，模型可见错误为 `mcp: /usr/bin/node -e process.exit(3) --api-key=TOPSECRET-XYZ: initialize failed: …`。
- 可达性：插件层只把自注入的 `server_browser` 白名单 stdio 交给 gateway（其 args 是桥路径/会话文件，无凭据），所以当前不可直接触发；但 gateway 的 `Config.servers` 是通用配置，任何 profile 组合都可能放带凭据的 stdio server，且错误进模型上下文与日志。
- 修法：`#label` 只用 command 或 `command + args.length`，错误文案不回显 args；确需定位时用 server 配置名。

#### BM-17 · P3 · 非法 base64 图片块写成损坏文件且报成功

- 位置：`mcp-gateway.js:288-305`（`:303` `writeFileSync(path, Buffer.from(block.data,'base64'))`）。
- 实测：`data:"!!!not-base64!!!"` → `images:[{path:"/tmp/paseo-mcp-images-*/fake-badimage-*.png",mimeType:"image/png"}]`，文件 7 字节，调用成功。
- 影响：模型拿到「成功 + 图片路径」，损坏要到 `read_image` 才暴露；比「失败要响亮」退一步。
- 修法：写入前校验 base64（字符集 + 长度对齐 + 解码长度），非法则抛 `mcp: <server>/<tool> returned a malformed image block`。

#### BM-18 · P3 · 两处注释与实现/上游相反（上轮 BM-11）

- `paseo-system-envelope.js:208-214`：「a prompt carrying an image is a user turn by construction」；实测 `promptSource([legacy, image]) → {kind:'paseo'}`（实现只看 text 块）。可达性分析：正常用户路径上游会把这类 prompt 重包成 `user-message`（`prepareAgentMessage`），所以真实误分类只发生在 BM-03 的过匹配路径；但这句注释会让后来者「按注释修代码」把带图卡的 agent 消息降级成用户回合。
- `mcp-http.js:21`：注释称由 `harness/mcp-gateway-check.mjs` 驱动，仓库实际只有 `mcp-gateway-call-check.mjs`/`mcp-gateway-guard-check.mjs`/`mcp-gateway-transport-check.mjs`，该文件名不存在（grep 仅此一处引用）。
- 修法：改注释（不改行为）：图像句改成「只看 text 块；上游正常路径会把用户伪造信封重包成 user-message」；harness 引用改成真实文件名。

## 4. 阴性结论

### 4.1 修复轮核查（`6394809` 落地情况，独立复现）

| 条目 | 结论 | 本轮证据 |
|---|---|---|
| BR-06 / BM-01 取消贯穿 | **已修复** | `probe-http.mjs`：在途取消 → `mcp: tools/call canceled` 且服务端观测到 socket 提前关闭（`closedEarly=true`）；预取消 → 不发请求；取消后 gateway 仍可用；`probe-stdio.mjs`：取消 → 收到 `notifications/cancelled {requestId:3}`，共享子进程继续可用；取消的图片调用不落盘（harness 17/17 亦覆盖） |
| BR-07 / BM-02 `structuredContent` | **已修复** | `probe-http.mjs`：纯结构 → 值带 `structuredContent.answer=42`、`content:""`，render 输出 `{"answer":42}`；文本+结构 → 两者都保留；结构化错误 → 错误文案带 `browser_no_host` 而非 `(no message)` |
| BM-03 `CallToolResult` 校验 | **已修复** | `probe-http.mjs`：`content:"hello"` / `isError:"true"` / `{task:{…}}` / `structuredContent:[1,2]` 全部抛错并点名字段与 `server/tool` |
| 修复不是「harness 假绿」 | **已核实** | `dsh-tools/lib/types/index.d.ts:120-132` 要求 async work observe/forward `exec.signal`；`dsh-tools/lib/index.js:3406` 实际调用 `tool.execute(exec.arguments, exec)`；原生 `dsh-mcp-client/lib/index.js:144` 同样传 `execution.signal`。harness 手工构造 `exec` 与真实运行时形状一致 |
| BR-08 图片 staging/归属（非本 lane 文件） | **已修复**（harness 46/46 + 源码） | `6394809` 给 `image-host-path.js` 加 `ensureCopyDirectory()`（lstat + uid + 0700）、`reusableCopy()`（lstat 常规文件 + size）、随机 staging 名 + `COPYFILE_EXCL`；`harness/image-host-path-check.mjs` 46/46 通过（含预置 symlink 写穿 victim 的反例）。逐行审查该文件属其他 lane，本 lane 只核查落地 |
| 内嵌桥新鲜度 | **已核实** | `6394809` 同时更新 `paseo-plugin/server/bridge-assets.ts`（559984→634020 字节）；`harness/bridge-assets-check.mjs` 2/2 通过（21 个桥文件逐字节一致） |

### 4.2 复核后判定「不是缺陷」（避免误报）

- **空结果 `{}` → 成功空内容**：用安装的 `@modelcontextprotocol/client@2.2.0` 的 `specTypeSchemas.CallToolResult` 校验，`{}` 合法且被规范化成 `{content:[]}`（该版本支持到 2025-11-25，`content` 已可省略）。原生 `dsh-mcp-client` 走同一校验，行为一致，**不登记为缺陷**。
- **`structuredContent` 为数组时 gateway 抛错**：同上，2025-11-25 的 client schema 更宽松，但 gateway 声明并实现的是 2025-06-18（该版本要求 object）；方向是「严格且响亮」，不是错误。
- **`task` 结果被 gateway 响亮拒绝**：原生 client 的 schema 允许 `task` 且会静默丢弃它（`dsh-mcp-client/lib/index.js:216-245` 只投影 content/structuredContent），gateway 更严格，符合本仓库「失败要响亮」。
- **会话 404 恢复**：`probe-http2.mjs` 实测「当前调用响亮失败（`mcp: tools/list failed with HTTP 404: session not found`）→ 下一次调用重新 initialize 并成功（initializeCount 2）」，不是死循环也不是静默。
- **`MAX_TOOL_PAGES=100`**：实测 100 页后抛 `refusing to cache a partial catalog`，有界。
- **`tools/list` 取消不污染缓存**：实测取消后下一次 `listTools()` 重新读目录成功。
- **server→client 请求 id 撞车**：`pickResult` 只把无 `method` 的帧当答案，实测 `[{id:1,method:'ping'},{id:1,result:{ok:true}}]` → 返回 `{ok:true}` 且 stderr 记录一条无法回答的提示；stdio 侧同形状也不劫持在途调用（`probe-stdio.mjs` collide 用例）。
- **`dispose()` 阶梯**：实测 `pid` 在 `dispose()` 后不再存活；disposed 客户端后续调用点名 `client disposed`；死二进制不重启（第一次 `failed to start: … ENOENT`，第二次同样，不形成重启循环）；`ctx.effect` 在插件卸载时对所有 client 调 `dispose?.()`（HTTP client 无资源，optional 调用安全）。
- **环境清洗**：stdio 子进程用 `scrubbedParentEnv()` + 配置 `env` 覆盖（harness 断言 PATH/HOME/代理保留、凭据形状剔除、配置值生效）。
- **图片路径安全**：`pathSegment` 只留 `[A-Za-z0-9_-]` 且截断到 64，模型控制的 tool 名不能目录穿越；`mkdtempSync` 目录默认 0700；`imageSequence` 跨调用单调，避免同名覆盖。
- **参数守卫**：`normalizeToolName`（NFKC→NFD→去组合符→白名单→小写）与 folded-call 识别覆盖真实踩坑形状，`GATEWAY_TOOL_KEYS` 把 `archive_subagents` 也当本进程工具；`transportOf` 对 both/neither/typo 都点名（harness 70/70 + 10/10）。
- **白名单与 legacy SSE（源码核对）**：`paseo-plugin/server/dsh-process.ts:956-1006` —— stdio 仅 `GATEWAY_STDIO_SERVERS.has(name) && selfInjected.has(name)` 才进 gateway（`:969`），其余 stdio 仍挂原生 client 且 `failOnStartupError:true`（`:975-990`）；`type:"sse"` 按名字拒绝（`:996-1003`）；未知/缺失 `type` 也拒绝且不回显 `headers/env/args`（`:1005-1026`）。与 `AGENTS.md`「MCP 注入与 gateway」一节一致。
- **审批（`approval.js` 全文 + `p003-bridge-check` 10 项）**：只对 owned session 认领、`allowed-once` 是唯一正向、超时→`unavailable` 且通知 `timedOut:true`、回合取消→`cancelled`、畸形答复不放过、监听器/定时器成对清理；桥侧 `transport.notify` 是同步 fire-and-forget（不会产生未处理拒绝），迟到的审批错误响应被 `transport.js` 按未知 id 静默丢弃（`#handleIncomingResponse`）。**未发现新问题。**
- **per-agent MCP 挂载**：`server.js:3790-3809` 把 entries 挂在 agent scope（`:3805` `agentCtx.plugin(...)`），不是进程级，所以多会话各自的 URL/token 不会串（`:3783-3789` 注释与实现一致）。
- **失败响亮方向**：`isError` 结果抛成工具失败、空 body/无 result/无 tool 数组都点名失败、未知 server 点名——修复轮没有回退这些方向。

### 4.3 有意边界（不登记为缺陷）

- stdio 子进程死后**不自动重启**：防止坏二进制重启循环，每次调用点名失败；运维含义是「一次崩溃后该 server 直到桥重启都不可用」。
- `mcp_list_tools` 的 `total` 是目录总数、`tools` 是 query 过滤结果：query 非空时渲染头部「N tool(s)」与列表条数不一致，属展示取舍（上轮已定），未单列。
- HTTP 传输「一次 POST 一问一答」没有 server→client 回写通道：BM-07 的一半是设计边界，不是漏实现。
- `cacheTools` 默认真：是 gateway 省上下文的核心设计；问题只在失效通道（BM-04）。

## 5. 未验证项（不当作结论）

- 未对**真实 Paseo HTTP MCP server / Server Browser 桥**跑：server→client 请求、`list_changed`、多行 SSE、批处理帧、task 结果在真实 server 上是否出现，未知；BM-14/15 是「协议允许但当前 server 未观察到」的互通缺口。
- 未在**真实 DSH 回合**里观测取消：已核对运行时契约（`exec.signal`）与原生 client 用法，但真实 turn cancel → gateway 的端到端延迟/副作用未测。
- 未跑 `harness/mcp-injection-check.cjs`：它需要编译后的 `harness/index.server.js`（仓库未预置，编译产物会落到仓库内），超出本 lane「只写报告」的最小离线范围；白名单/SSE 结论因此是【源码推断】+ 上轮同区域检查记录。建议 plugin-process lane 在编译产物上补跑。
- 未做内存压力实测（BM-10）、未测真实浏览器宿主在线/离线/半可用下的 `unavailable` 语义（BM-01/02 只用假 server 结果驱动）。
- 未验证 Paseo App 对 `source.kind='paseo'` 误分类的最终呈现（BM-03 只验证到桥的 source 选择与上游解析器差分）。
- `image-host-path.js` 的逐行审查属其他 lane；本 lane 只核查 BR-08 修复落地（harness + diff）。

## 6. 跨 lane 提示

1. **plugin-process / plugin-injection lane**：`dsh-process.ts:940-1030` 的白名单 + SSE 拒绝逻辑本 lane 已读码核对，但建议在编译产物上跑 `harness/mcp-injection-check.cjs`（需 `harness/index.server.js`），把「HTTP 与白名单 stdio 走 gateway、非白名单 stdio 仍原生、sse 按名字拒绝」从源码推断升级为实测。
2. **bridge-server lane**：`transport.js` 已在本轮前加了入站帧 `maxPendingBytes`（`#reportOverflow`），但 MCP 客户端侧的 `response.text()`/readline 仍无上限（BM-10）；两处建议同口径处理。`transport.js` 的 `#handleIncomingResponse` 对未知 id 静默丢弃是审批迟到回执无害的原因，动它时注意别把「迟到审批答复」变成错误日志噪音。
3. **image-host-path lane**：BR-08 修复已落地（`ensureCopyDirectory`/`reusableCopy`/随机 staging + `COPYFILE_EXCL`），harness 46/46；该文件本 lane 未逐行审，交叉验证时请以 `image-host-path-check.mjs` 为准。
4. **文档 lane**：`mcp-http.js:21` 引用的 `harness/mcp-gateway-check.mjs` 不存在（BM-18）；`paseo-system-envelope.js:208-214` 的图像注释与实现相反（BM-18）；两处可随文档修正一并处理。
5. **任何后续给 gateway 增加新 MCP server 的改动**：先补 BM-01/BM-02（探测短超时+第三态）与 BM-16（错误文案不含 args），否则新增 server 会把「每次列目录阻塞」和「命令行泄露」的暴露面一起放大。

---

*报告生成时间：2026-11-03 · 基线 `0c82df5` · 只读审查，未修改产品代码/文档/harness。*
