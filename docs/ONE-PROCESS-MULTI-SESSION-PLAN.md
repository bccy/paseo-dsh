# 一进程多会话改造方案（2026-10-24）

基线：`main @ cdb4022`。目标：把「一个 Paseo 会话 = 一个 `dsh` 子进程」改成
「一个 `dsh` 子进程承载多个会话」，消除每次新建会话的 3.5 s 冷启动。

> 本文只记录**已验证的事实**与**待批准的改造计划**。未验证项单列在第 6 节。
> 所有行号锚定 `cdb4022`，改造前请以实际源码复核。

---

## 1. 为什么要改

实测（daemon 日志配对 `Creating agent` → `Created agent`）：

| provider | 首次 | 之后 |
|---|---|---|
| `opencode` | 1.5–1.6 s | **210–230 ms** |
| `deepseek-harness-native` | **4.2–4.5 s** | 还是 4.2–4.5 s |

opencode 有常驻 server，之后只是开会话；dsh 每次都起全新 node 进程、从零加载整个 profile。

冷启动 3.5 s 的构成（隔离实测 + CPU profile）：

- node 裸启动 26 ms，`dsh --help` 86 ms，`--dump-config` 134 ms
- **boot 到能响应 `initialize` = 3.5 s**
- `compileSourceTextModule` 占自耗 20.4%、cordis 加载 9.3%，空闲仅 4.6% —— 纯 CPU 编译装配

已验证**无效**的优化：`NODE_COMPILE_CACHE`（3927 ms vs 基线 3466 ms，反而更慢）；
禁用 `dsh-web-app` 的 51 个 `ui-*` 行只省 ~100 ms（3572 → 3463 ms）。

**结论：慢的根源是进程 1:1 绑定，不是 DSH 本身。**

---

## 2. 架构现状与阻塞点

```
Paseo daemon → paseo-plugin/server/*.ts → stdio JSON-RPC → dsh-bridge/lib/*.js → DSH profile
```

三处把进程与会话绑死：

| # | 位置 | 现状 |
|---|---|---|
| 1 | `paseo-plugin/server/session.ts:427` | 每个 `DshSession` 都 `new DshProcess()` |
| 2 | `paseo-plugin/server/dsh-process.ts:420-426` | spawn 前写一份 `--patch`，内含 per-agent 的 `callerAgentId`；DSH 只在 boot 读一次 |
| 3 | `dsh-bridge/lib/server.js:2078` | `const meta = { cwd: this.cwd }`，`this.cwd` 只在 `initialize` 赋值 |

`docs/ADOPTION.md:33` 把第 1 条写成设计原则（「一个会话 = 你的运行时一个进程」），
但那是**进程隔离换崩溃隔离**的取舍，不是 DSH 的限制。

---

## 3. 已验证的可行性（4 条前提）

### 3.1 一进程多会话在协议层天然成立 —— 实测

同一 `dsh --profile paseo` 进程，两个 `sessionId` 并发 `session/prompt`：

```
sess-A 21 条事件 / sess-B 21 条事件，各自 turn/end 各 1 次，无串扰
```

`session/prompt` 收 `params.sessionId`（`server.js:577`），内部 `getOrCreateSession(sessionId)`
（`server.js:2018`）。桥的 `this.sessions`（`:191`）本来就是 `Map<sessionId, rec>`。

### 3.2 per-agent MCP 挂载成立 —— 实测（这是原判「架构级阻塞」的那条）

同一进程内 `ctx.agents.create()` 两次，各自 `setup` 里
`agentCtx.plugin(mcpGateway, { servers: { paseo: { url: '...?callerAgentId=A|B' } } })`：

```
STEP3 probe-a gateway mounted caller=caller-AAA
STEP3 probe-b gateway mounted caller=caller-BBB
STEP5 A sees: archive_subagents,mcp_list_tools,mcp_tool_schema,mcp_call_tool
STEP6 A list ok total=61   STEP6 B list ok total=61
J3 A OWN(caller-AAA)=true  OTHER(caller-BBB)=false
J3 B OWN(caller-BBB)=true  OTHER(caller-AAA)=false
M4 before dispose A=29 B=29
M6 after dispose  A=25 B=29
```

身份交叉零命中；工具注册不撞名；销毁清理正确（HTTP client 无 `dispose`，`client.dispose?.()`
是 no-op，安全）。

源码依据：
- 每个 agent 独立 scope：`dsh-agent-loop/lib/index.js:778-779`（`createScope(loopCtx, this)`）
- 工具按 scope 分层、查重只限同层：`dsh-tools/lib/index.js:2982`、`dsh-scope/lib/index.js:27-30`
- 子 fiber 继承 scope：`cordis/src/fiber.ts:236`
- 官方先例：`dsh-acp/lib/index.js:216-218`（`mountAcpMcpServers` → `agentCtx.plugin(McpClient, config)`）
- `dsh-mcp-client/lib/index.js:768-771` 注释：「Agent-scoped MCP servers may reuse a namespace in another Agent」

> 「DSH resolves MCP servers only at boot」只在**配置层**（`--patch` / `cordis.patch.yml`）成立，
> 插件层不成立。这是本方案成立的关键。

### 3.3 cwd 是会话级 —— 内核实测成立，桥层不成立

内核：两会话各自 `pwd` 正确、日志按 cwd 分目录、lease 正常
（`dsh-working-directory/lib/index.js:77` per-session 投影，全仓无 `process.chdir`）。

桥层：只发一次 `initialize`（cwd-a），建两个会话 → **两个都落 `cwd-a`**
（`server.js:2078` 用进程级 `this.cwd`）。桥无 per-session cwd 入口。

变通「重发 initialize」不可靠：已存在会话不受污染，但并发两 workspace 是竞态。

### 3.4 多会话下子代理正常 —— 实测

```
session.child-opened A: parentSessionId=v4-sub-a-..., cwd=.../cwd-a
session.child-opened B: parentSessionId=v4-sub-b-..., cwd=.../cwd-b
paseo/subagents A -> 只有 A 的子会话；B -> 只有 B 的
事件计数 v4-sub-a=54 34a071d9=36 / v4-sub-b=27 7bfb5311=13（无串扰）
```

`this.children`（`server.js:236`）是进程级 Map，但 key 是全局唯一子会话 UUID；
parentId 取自子会话自己的 durable header（`server.js:294`），不靠进程状态推断。
**`this.children` 可保持进程级，不用改。**

---

## 4. 必须修的 5 个 P0（桥内单例存会话级意图）

穷举 `dsh-bridge/lib/server.js` 24 个实例字段 + `lib/` 其余 13 个文件，只有这 5 处会串台，
且都是**必然碰撞**不是偶发：

| # | 字段 | 读写点 | 用户会看到什么 |
|---|---|---|---|
| P0-1 | `this.cwd` | :164/:546 写 → :2078 `meta.cwd`、:1154 skills、:337、:1348 | B 项目新建会话，工具在 A 目录读写；composer 的 `/` 菜单列 A 的 skills |
| P0-2 | `this.provider/model/reasoningEffort` | :168-170 声明，:644-647 写，:2038-2040 读 | 给未建 agent 的会话切模型写进进程默认，之后所有新会话继承它 |
| P0-3 | `this.pendingPlanMode` | :178/:609/:623/**2159** | 单布尔 + **:2159 消费后永不置回 false** → 一次 true 后本进程新建的每个会话都被强制 plan，而 UI 读真实状态显示 build |
| P0-4 | `this.childAnchors` | :228/:1261/:1281/:1475 → `child-anchors.js:58-66` | `withdrawnSince(targetSeq)` **遍历全部会话的子代理，无 root 过滤** → 撤回 A 误杀 B 的子代理；**且 `ChildAnchors` 无 delete 方法**，误杀窗口随进程寿命单调变宽 |
| P0-5 | 无 `session/close` | `handleRequest` :1959-2004 | 6 张表只增不减，`owns()` 恒真 → user-questions 继续为已关闭会话路由 |

**正确范式（照抄）**：`pendingPresets`（`server.js:181` 声明、`:186` 实现）——
全文件唯一已按会话隔离的「排队意图」。

**已核实无问题**：`snapshotOwners`（key=`sessionId:callId`）、`revertInflight`、
`assistantStreams`、`sessionCreations`、`this.children`。

**非串台但要注意**：
- `llmFiber` :248 —— 泄漏非串台。:536 两次 initialize 不同 provider 会覆盖引用，前一个 adapter fiber 丢失 dispose 句柄。
- `initialized` :245 —— 单布尔。多会话下门槛变「本进程有过任意 initialize」，B 没自己 initialize 也能 prompt，静默用 A 的路由。
- `server.js:1348` 的 `session?.header?.cwd ?? this.cwd` —— 修法应**删掉 `?? this.cwd` 走 fail-open**，不要用 `header.cwd` 兜底：路径必须按 `workingDirectory` 投影解析（:1334 `ensure` / :1343 `get` 才权威），`header.cwd` 是「原项目目录」不是当前目录。

---

## 5. 改造清单

### 5.1 `dsh-bridge/lib/server.js`（约 140–180 行）

| 项 | 改法 |
|---|---|
| `initialize` :512-556 | 增加可选 `sessionId`，route/cwd 落 per-session 表；无 sessionId 时保留现语义作进程默认 |
| `createSession` :2034-2090 | 所有 `this.provider/model/reasoningEffort/maxTokens/cwd`（:2037-2041、:2076、:2078）改为 per-session 参数，回退进程默认 |
| P0-1~P0-3 | 3 个标量 → `Map<sessionId, ...>`，6 处读点改 key |
| P0-4 | `childAnchors.withdrawnSince(targetSeq, rootId)` 加 root 过滤；`ChildAnchors` 补 `delete(sessionId)`，会话关闭时清 |
| P0-5 | 新增 `session/close` 帧，清 6 张表 |
| `initialized` :245 | 单布尔 → `Set<sessionId>` |
| `llmFiber` :248 | 单值 → `Map<provider, fiber>`，或显式 dispose 旧的 |
| gateway 挂载 | `setup`（:2062、:2068 preset 分支、:2138 `resumeSetup`）里 `installSelection(agentCtx)` 之后加 `await agentCtx.plugin(mcpGateway, cfg)` |
| `configSet` :638-675 | rec 不存在时不再写进程默认（:644-647），改 per-session 待定 route 表 |
| `planSet` :617-635 | `this.pendingPlanMode` 单值（:623）→ Map（照抄 `pendingPresets`） |

> 改完**必须**跑 `node paseo-plugin/scripts/generate-bridge-assets.mjs` 重生成内嵌桥。

### 5.2 `dsh-bridge/lib/child-anchors.js`（约 20 行）

`withdrawnSince` 加 root 过滤；补 `delete`。`delegated-cancel.js` 约 5 行同步。

### 5.3 `dsh-bridge/lib/mcp-gateway.js`

基本不动——`apply`（:167）已是闭包式状态（`const clients = new Map()` 在 :177），挂 agentCtx 即自动 per-agent。
唯一注意 `registerSubagentArchiveTool(ctx)`（:171）在 agent scope 重复注册：实测不撞名（每 agent 独立 scope 层），无需改。

### 5.4 `paseo-plugin/server/dsh-process.ts`（约 30–40 行）

| 项 | 改法 |
|---|---|
| `#handlers` :356 | 单对象 → `Map<sessionId, handlers>` + 进程级 `{onExit, onLog, onProtocolError}` |
| `setHandlers` :397-409 | 保留（温池在用），新增 `attachSession(id, handlers)` / `detachSession(id)` |
| `#dispatch` :886-944 | 按 `frame.params.sessionId` 查 Map。**frame 里字段齐全，这是最容易的一步** |
| 13 处 `this.#options.sessionId` :477…756 | 改显式参数 |
| `prepareMcpPatch` :323-347 / `:420-426` | 删掉 gateway 那条 profile 级 patch 条目（改由桥在 agent scope 挂）；`mcpEntries()` 的翻译逻辑保留，非白名单 stdio 仍走原生 |
| `mcpServers` 下沉 | 从构造参数改成 per-session 传入 `createSession` |
| `onExit` :448-454 | fan-out 全部会话 |

### 5.5 `paseo-plugin/server/session.ts`（约 15%）

| 项 | 改法 |
|---|---|
| `open()` :408-453 | `takeParked` 或 `new DshProcess` → 从进程池取 + `attach(this.#dshSessionId, handlers)` |
| `close()` :1308-1326 | detach；引用计数归零才 park/shutdown |
| `#onStatus` :1335-1362 / `#onSessionEvent` :1646-1689 | **加前置过滤**：别的 root 的 frame 在路由层丢弃，别落进「当子会话」分支。**不改会产生大量 `unknown subagent session` 噪音并可能误判** |

### 5.6 `paseo-plugin/server/provider.ts`（约 20%）

| 项 | 改法 |
|---|---|
| 新增 `#processes: Map<profileKey, DshProcess>` | profileKey = cwd + env 指纹 + MCP 集合指纹 |
| `#open()` :771-1101 | 先从池取进程再构造会话 |
| `#parked.quiesce` :853 | **共享进程后不能杀**（会带走别的会话）→ 逻辑重写 |
| `close()` :358-372 | 按进程池关，不逐个 `session.close({park:false})` |

### 5.7 `paseo-plugin/server/parked-sessions.ts` —— 改，不重写

回归脚本的 32 条断言全针对池自身行为（park/take/静默/复用/TTL/超容/discard/stop），
与「进程里几个会话」无关，改 per-route 实例后**仍全绿**。

但 `park()` :160 调 `setHandlers(silentHandlers)` 会**静音整个进程** —— 多会话下会把同进程的
活跃会话一起静音。必须改成只静音该会话。`quiesce()` :228-256 的「等进程真死释放会话日志写锁」
逻辑（`RELEASE_TIMEOUT_MS` :73）要保留，那是真机踩出来的坑。

---

## 6. 回归脚本冲击面

**现状：没有一个脚本是红的**，所以以下全部是前瞻判定。基线（`HEAD=c6abfb9`，04:24–04:35 采集）
约 1420 条断言全绿，含 `revert-check` 98/98。

| 分类 | 数量 | 说明 |
|---|---|---|
| A 类（行为断言，不用改） | ~95%（~1350 条） | — |
| B 类（写法要改） | 2 脚本 / 8 条 | — |
| **C 类（源码正则，等价重构必误报）** | **5 脚本 / 约 22 条** | 见下 |
| **D 类（整份重写）** | **1 个** | `fake-dsh-bridge.mjs` |

### 6.1 D 类：`harness/fake-dsh-bridge.mjs`（824 行）—— P0，所有多会话验证的前置

根因：`rootId` 是**模块级单例**（:112），`handle()` 入口一次性捕获（:491-493），
此后约 25 处 `notify(... { sessionId: rootId })` 写死。

改法：`let rootId = null` → `Map`；`handle()` 按 sessionId 登记；场景函数从无参改成
`emitScenario(rootId)`，由 `session/prompt` 的 `params.sessionId` 决定目标；新增 `multi` 模式。

**连累 6 个下游**：`subagent-check` / `steer-check` / `mcp-injection-check` /
`assistant-stream-check` / `image-check` / `session-request-check`，改后全部复跑。

### 6.2 C 类 22 条（10 组变异已实证）

最危险的三个：
1. `revert-check.mjs:429` —— `takeParked:` 箭头函数**只换行就红**
2. `thinking-check.cjs:233,238` —— 跨行 `\s*\n\s*` 匹配 JSX，**属性顺序调换就红**
3. `style-check.cjs:684` —— `/rowIconColor\(colors, data\.status, data\.diff\)/`，**调用换行就红**

分布：`revert-check` 4 条实证 + 约 20 条同类；`thinking-check` 7；`style-check` 4；
`agent-message-check` 3；`tool-call-check` 4。

对照组（证明只匹配字面量不匹配语义）：加 per-route 池字段不动原池 → 绿；抽 `#isIdle()`
helper 但保留原字面量 → 绿；`iconColor` 尾部加 `?? null` → 绿。

改法优先级：① 有纯函数 → import 编译产物断言输入输出；② 有事件流 → 假桥跑一遍断言事件；
③ 有日志 → 断言日志行（`parked:discard` / `parked:take`）；④ 只能靠源码的（React JSX）→
改结构解析（括号配对找「同时带 `onLayout` 和 `style` 的 JSX 元素」），不依赖顺序和换行；
⑤ 确实无法行为化的 → 接受，加注释并放宽为 `indexOf`。

### 6.3 B 类 8 条

- `subagent-check.cjs:595-599` —— 用 pid 断言「重开是冷启动」，多会话后 pid 必然相同。
  **改法**：断言该 session **重新发了 `initialize` 帧**（每进程一次，新进程必有、复用则无）。
  `:576` 同类，可删（`:581` 的 `parked:discard` 已覆盖意图）。
- `context-usage-check.cjs:30` —— `FakeProcess` 只实现 4 个方法，靠模块级替换。
  **改法**：`DshSession` 的进程获取改成可注入（构造参数 `createProcess?`），不依赖模块级替换。

### 6.4 两个初判被推翻

- `parked-sessions-check.cjs` **不是 D 类，是 A 类**（32 条全是池自身行为）。
- `subagent-check.cjs` 的 pid 断言**只有 2 处真会挂**，不是「大段」。

### 6.5 需要**新增**断言（不是改现有）

- `mcp-injection-check` 测不出「同进程两会话 `mcpServers` 不同会冲突」——它每个 `session.open`
  都起独立进程。改造后必须新增：同进程内两会话各挂各的 gateway、身份不串（本方案的 3.2 已验证可行）。
- 5 个 P0 各需一条「两会话同时操作，互不影响」的行为断言。

### 6.6 `plugin-check.cjs` 无法隔离验证

隔离 `DSH_HOME` 跑必红：`FAIL catalog lists models without initialize — 0 model(s)` 然后超时。
原因不是回归——隔离 profile 是空壳，没模型没凭据。

**它本质上必须用真实 profile**，意味着跑它必然改写 live profile 的桥
（`~/.dsh/profiles/<name>/node_modules/dsh-paseo-bridge`）。**跑前记 hash/mtime，跑后比对。**

---

## 7. 工作量

| 优先级 | 项 | 人日 |
|---|---|---|
| **P0** | `fake-dsh-bridge.mjs` 多会话化（所有验证的前置） | **1.0** |
| P1 | 桥：5 个 P0 + `session/close` + gateway 挂载 + cwd 下沉 | 2.0 |
| P1 | 插件层：`DshProcess` handlers Map + `#dispatch` 路由 + 进程池 + `parked` 改 per-route | 2.0 |
| P1 | `revert-check` 4 条 + `thinking-check` 7 条 | 0.6 |
| P2 | `style-check` 4 + `agent-message` 3 + `tool-call` 4 | 0.4 |
| P2 | `subagent-check` 2 处 pid + `context-usage` FakeProcess | 0.4 |
| P3 | `revert-check` 其余 ~20 条同类（建议**删重复**而非重写，`file-snapshot-check.mjs` 已覆盖） | 0.3 |
| | **合计** | **约 6.7** |

不含真机调试。按本仓库教训（`docs/FIELD-NOTES.md`：「离线断言全绿不等于能用」，撤回曾两次
mock 通过、真机必挂），真机验收占比可能更高。

---

## 8. 未验证项

| 项 | 说明 |
|---|---|
| 真桥 `createSession` 路径下的实际挂载 | 只验证了「进程内 `agents.create` + `agentCtx.plugin`」这个机制，没改桥源码实测 |
| 跨 cwd 会话共存 | 3.3 的内核结论是实测，但**桥层改造后**的端到端未测 |
| 真实模型回合中调用 `mcp__paseo__*` | 用的是直接 `def.execute()`，绕过了模型回合与权限门 |
| `dsh-web-app` / `dsh-prime-memory` 叠加 profile | 只在 `dsh-base` 最小 profile 验证 |
| `unarchiveSession` 后已 dispose 的 agent 能否 resume | 未测 |
| `revert-check` 其余 ~20 条是否**全部**误报 | 只实证 4 条，其余为同类模式静态推断 |
| P0-4 的误杀 | 概率上几乎必然（seq 空间按会话独立编号），但未在真机观测到打断事件 |

---

## 9. 已排除的路线

| 路线 | 为什么不做 |
|---|---|
| `NODE_COMPILE_CACHE` | 实测反而更慢（3927 vs 3466 ms） |
| 砍 `dsh-web-app` / 禁用 51 个 `ui-*` 行 | 只省 ~100 ms；且 `dsh-prime-memory` 硬依赖它的 `webServer`/`connection`（`dsh-prime-memory/dist/index.js:68` `inject` 声明），砍不掉 |
| 温进程池（复用已启动进程） | 收益远小于一进程多会话；且同样卡在 MCP 身份（现已证可 per-agent 挂，但池化仍需动态绑定） |
| 改 `--patch` 运行时重载 | DSH 无此 API（`dsh-app-boot/lib/index.js:4138` 只在 boot 读一次） |
| 按 `callerAgentId` 分进程 | 等于回到一进程一会话 |
