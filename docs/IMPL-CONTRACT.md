# 一进程多会话改造 · 实施契约（冻结）

> **历史文档，内容保持当时原样。** 文中提到的 `paseo-plugin/server/parked-sessions.ts`（含 `harness/parked-sessions-check.cjs`）已在 `bf093a7` 删除——它的 `hold`/`release`/`quiesce`全是空壳，共享进程的引用计数已收回 `provider.ts` 的 `#poolClaims`。

基线：`main @ cdb4022`，分支 `feat/one-process-multi-session`。
本文是并行实现的**唯一契约源**。各任务只改自己写域内的文件，跨域只按本文约定调用。

---

## 0. 已完成（不要再动）

`harness/fake-dsh-bridge.mjs` 多会话化已落地并验证：

- `rootIds: string[]` 记录本进程服务过的所有会话；`rootId` 降级为「当前场景绑定的会话」
- `handle()` 按请求自带 `sessionId` 绑定；`initialize` 不带 id，不干扰绑定
- 场景标志 → `scenarioState: Map<sessionId, {emitted, liveChildEmitted, rootTurnOpen, promptAttempts, cancelPrompts, cancelSteps}>`
- 新增 `multi` 模式（进程级 `multiEmitted` 守卫，交错发全部会话的事件）
- 新增 `harness/fake-bridge-multi-check.mjs`：20 条断言，含变异门

下游六个回归全绿：subagent 78、steer 25、mcp-injection 13、assistant-stream 7、image 8、session-request 11。

---

## 1. 协议契约（桥 ↔ 插件）

### 1.1 `initialize` 新增可选 `sessionId`

```
initialize { cwd, provider?, model?, reasoningEffort?, maxTokens?, sessionId? }
```

- **带 `sessionId`**：把 `cwd`/route 落到该会话，返回 `{ serverInfo, route }` 不变。
- **不带 `sessionId`**：保持现有语义 —— 设定**进程默认**，供后续未指定 route 的会话回退。
- 无幂等冲突：重复调用带不同 `sessionId` 是合法的（不同会话各自 initialize）。

### 1.2 新增 `session/close`

```
session/close { sessionId } -> { closed: true }
```

清掉该会话在桥内的全部状态：`sessions` / `controls` / `children` / `assistantStreams` /
`pendingPresets` / `pendingPlanMode` / `childAnchors`。未知 sessionId 返回 `{ closed: false }`
（幂等，不抛错）。**这是 P0-5。**

### 1.3 `createSession` 接受 per-session 参数

`createSession(sessionId, options?)`，`options` 可含 `{ cwd?, route? }`。
缺省回退进程默认（现有 `this.cwd` / `this.provider` 等）。**这是 P0-1 / P0-2。**

### 1.4 桥内状态迁移（P0-1 ~ P0-4）

| 原字段 | 新形态 | 说明 |
|---|---|---|
| `this.pendingPlanMode`（布尔） | `this.pendingPlanMode = new Map<sessionId, boolean>` | 消费后**删除该 key**，不留在 false。照抄 `pendingPresets`（:181）范式 |
| `this.initialized`（布尔） | `this.initializedSessions = new Set<sessionId>()`，`this.initialized` 保留为「本进程有过任意 initialize」 | `prompt` 的前置判断用 Set |
| `this.llmFiber`（单值） | `this.llmFibers = new Map<provider, fiber>` | 避免覆盖泄漏；`shutdown` 全部 dispose |
| `childAnchors.withdrawnSince(targetSeq)` | `withdrawnSince(targetSeq, rootSessionId)` | **必须加 root 过滤**；`ChildAnchors` 补 `delete(sessionId)` |
| `this.cwd` | 保留为进程默认；新增 `this.sessionCwd = new Map<sessionId, cwd>` | `createSession` 的 `meta.cwd` 用 `sessionCwd.get(id) ?? this.cwd` |

**`server.js:1348` 的 `session?.header?.cwd ?? this.cwd`**：删掉 `?? this.cwd` 走 fail-open。
**不要**用 `header.cwd` 兜底 —— 路径必须按 `workingDirectory` 投影解析（:1334 `ensure` / :1343 `get` 才权威）。

### 1.5 gateway 挂到 agent scope

`setup(agentCtx, agent)`（:2068 preset 分支、:2138 `resumeSetup`）里，`installSelection(agentCtx)` 之后
加载该会话的 MCP 条目。

**形状（2026-10-24 裁决，T2 提的 A 方案）**：帧传 `mcpEntries()` 的条目数组，即 DSH 自己的
patch 条目形状，不自造：

```json
{ "sessionId": "...", "entries": [
    { "name": "./mcp-gateway.js", "config": { "servers": { "paseo": { "url": "..." } } } },
    { "name": "@deepseek-ai/dsh-mcp-client", "config": { "serverName": "github", "transport": "stdio", ... } }
] }
```

桥侧机械加载，**不硬编码 gateway 的名字**：

```js
const entries = this.pendingMcpServers.get(sessionId);
if (entries !== undefined) {
  for (const entry of entries) await agentCtx.plugin(await import(entry.name), entry.config);
}
```

`await import(specifier)` 对相对路径（bridge 内的 `./mcp-gateway.js`）和裸包名
（`@deepseek-ai/dsh-mcp-client`）都成立。插件侧把 `MCP_GATEWAY_PLUGIN` 常量从
`"dsh-paseo-bridge/mcp-gateway"` 改成 `"./mcp-gateway.js"`（相对 bridge 的 lib 目录）。

**好处**：插件侧保留全部翻译逻辑（白名单 / 原生分支 / sse 拒绝），桥只做 `ctx.plugin`。

**已验证**：`agentCtx.plugin(gateway, cfg)` 可行，两会话身份零交叉、工具不撞名、dispose 清理正确。

### 1.6 `#dispatch` 的会话归属溯源（T2 发现，2026-10-24 补）

**不能只按 `params.sessionId` 查 Map。** 桥发出的这些帧里，`sessionId` 可能是**子会话 id**：

| 帧 | `sessionId` 语义 | 位置 |
|---|---|---|
| `session.child-opened` | **子**会话 id；`parentSessionId` 是直接父级 | `server.js:361-366` |
| `session.event` | 事件**来源**会话（子会话事件带子会话 id） | `server.js:273` |
| `session.status` | 同上 | `server.js:281` |
| `openChild` flush 的 held frames | 同上 | `server.js:378-381` |

且 `observeChildSession`（`server.js:313-322`）里 `children` 的 `parentId` 是**直接父级**，
可能还是子会话（孙代理场景）。所以必须**逐级溯源**：

```
确定 root(sessionId):
  1. #sessionHandlers.has(sessionId) → 就是它
  2. 否则沿 #childParent 逐级上溯，直到命中已 attach 的 root
  3. 环路必须终止（seen 保护）—— 孙代理有深层链
  4. 溯源失败 → 丢弃并 onLog 一行，不静默不抛
```

`#childParent: Map<childSessionId, parentSessionId>` 从 `session.child-opened` 帧填充。
**`child-opened` 必须优先处理**；若子会话的其它帧先到（`opened === false` 的 hold 路径），
丢弃 + `onLog` —— 桥的 `holdChildFrame` 保证它稍后会随 `child-opened` 重发。

---

## 2. 文件级写域（互不重叠）

| 任务 | 独占写域 | 禁止触碰 |
|---|---|---|
| **T1 桥** | `dsh-bridge/lib/server.js`、`dsh-bridge/lib/child-anchors.js` | 其余全部 |
| **T2 插件进程层** | `paseo-plugin/server/dsh-process.ts` | 其余全部 |
| **T3 插件会话层** | `paseo-plugin/server/session.ts`、`paseo-plugin/server/parked-sessions.ts` | 其余全部 |
| **T4 provider 与池** | `paseo-plugin/server/provider.ts` | 其余全部 |
| **T5 回归脚本** | `harness/*.cjs`、`harness/*.mjs`（**除** `fake-dsh-bridge.mjs`、`fake-bridge-multi-check.mjs`） | `dsh-bridge/`、`paseo-plugin/` |

**`bridge-assets.ts` 由 Lead 在 T1 完成后统一重生成**，任何人不得自行生成。

---

## 3. 依赖顺序

```
T1（桥）─┬─> T2（DshProcess）─> T3（Session）─> T4（provider/池）
         └─> T5（回归脚本）可并行，但断言多会话需 T2/T3 落地后才真跑
```

T2 依赖 T1 的协议契约（1.1~1.5），但**可以按契约先写**，不必等 T1 完成。
T5 独立，可全程并行。

---

## 4. 每个任务的验收

1. `node --check` / `npx tsc --noEmit`（插件层）
2. 自己写域内文件改动完成
3. **不改他人文件、不 commit、不 reload、不重启 daemon**
4. 回报格式：改了什么（文件:行号）/ 未验证项 / 需要谁配合

---

## 5. 绝对不能做

- 不 commit、不 push、不 reload 插件、不重启 daemon（Lead 统一做）
- 不改 `paseo-plugin/server/bridge-assets.ts`（Lead 生成）
- 不改别人写域内的文件；需要时先发约定给 Lead
- 不硬编码任何 provider 名、模型 id、本机路径
- 不削弱现有断言，只增不删
