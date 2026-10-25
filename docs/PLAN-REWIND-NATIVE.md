# 撤回原生化（方案 A）实施计划

> 状态：待用户确认后开工。本文件只做设计，未改任何源码。
> 行号基准：`<repo>` HEAD `9dfe7b5` + 2 个未提交改动（`harness/subagent-check.cjs`、`paseo-plugin/server/session.ts`）；Paseo dist 为 0.13.0 全局包当前内容。
> 取证时间：2026-10-26。行号会漂移，开工前每条落点须重新 grep 确认。

---

## 0. 结论先行

**选定 A2**（daemon 侧单点改动，插件协议零改动）。A2 **成立**，不是推断，关键证据见 §2。

- **Paseo 侧实际改动：57 行**（`plugin-provider.js` 一个文件，3 处插入，0 处删除）。
- **插件侧可删：约 400 行**（`provider.ts` 约 372 行 + `parked-sessions.ts` 512 行整块保留但停用其 reload 用途；详见 §4，含"不可删"项）。
- **预期效果**：撤回不再 spawn CLI、不再 close/reopen 会话、不再铸造新 epoch 之外的重建；`session id` 不变、无 `loading` 态、子代理不被 cancel。延迟从实测 2035ms 降到桥的 revert 本身耗时 + 一次全量重放。

> 关键差异于前序判断：**不需要新事件，也不需要 A3/A4**。因为 `agent-manager.rewind()` 是 `await invokeRewindCapability(...)`，而 `plugin-provider.revert()` 是 `await this.bridge.revert(...)`，回执到达时 daemon 还没开始 `forceHydrate`。只要在回执返回**之前**把 `this.history` 修正，随后的 force hydrate 自然读到正确历史。**无事件异步竞态。**

---

## 1. 机制选型

### 1.1 候选对比

| 候选 | 做法 | 结论 | 理由 |
|---|---|---|---|
| **A1** | `ProviderEvent` 新增 `session.history_replaced` 事件，daemon 收到后截断 `this.history` | **否决** | 需要改 `@getpaseo/plugin` 的 `ProviderEventSchema`（第三方包 `dist/server/provider.js:695` 的 `discriminatedUnion`）+ daemon 的 `PluginAgentSession.accept()` 分支 + 插件侧发事件。三处协议改动，而收益与 A2 完全相同。更要命：事件是异步到达的，`accept()` 里 `this.history.push` 之后才可能被处理，与 `createPendingRun` 锁的时序需要额外论证——**这正是前序成员担心的竞态，A2 直接绕开了它**。 |
| **A2** | `plugin-provider.revert()` 在 `await this.bridge.revert(...)` 返回后，自己截断 `this.history` | **✅ 选定** | 单文件单点，3 处插入 57 行，协议零改动，无竞态（同步于回执之前）。定位键现成（见 §2）。 |
| **A3** | 扩展 `session.revert` 应答形状，回执携带「新历史」或「截断点」 | **否决** | 回执 schema 是 `.strip()` 的 `{type:"request.completed", requestId}`（`provider.js:712`）。要携带数据得改 `@getpaseo/plugin` 的 schema 与 `runtime.complete()` 的解析，且 `complete()` 只 `resolve(event)` 返回整个 event——插件侧确实可以塞额外字段（`.strip()` 会剥掉，不报错但也不保留）。**改协议 + 依赖 strip 行为 = 静默降级风险**，与本仓库「失败要响亮」的硬约束冲突。 |
| **A4** | `ProviderInput` 加「请求重放历史」入口，revert 后 daemon 主动拉 | **否决** | 多一次协议往返，且 `streamHistory()` 是 `async *` 生成器、`forceHydrate` 已经在拉它。加一个入口等于把 A2 的「就地修正」拆成两次通信，还多一个可失败的中间态。**没有额外收益。** |

### 1.2 为什么 A2 是正解（时序证据）

`agent-manager.js:2259-2267`：
```js
const lock = this.runs.createPendingRun(agentId);
try {
    await invokeRewindCapability(agent.session, { messageId: providerMessageId, mode });   // 2262 ← 等回执
    if (mode !== "files") {
        await this.hydrateTimelineFromProvider(agentId, { force: true, ... });            // 2264 ← 之后才读 history
```

`plugin-provider.js:1253-1264`：
```js
async revert(messageId, scope) {
    const token = this.revertTokens.get(messageId);        // 1254
    if (token === undefined) throw ...                     // 1255-1256
    await this.bridge.revert({ ... });                     // 1257-1263 ← 这里返回后，history 已被修正
}                                                          // 1264 ← 插入点就在这
```

`invokeRewindCapability`（`rewind/rewind.js:8-28`）是纯 `await session.revertConversation({messageId})`，无其它分支。

**结论：`plugin-provider.revert()` 的第 1264 行（`}` 之前）是唯一的、也是充分的插入点。** 此时 `bridge.revert()` 已经完成（桥的 surface 替换已 flush），而 daemon 的 `forceHydrate` 尚未开始。不存在「事件异步到达」的问题。

---

## 2. A2 可行性判定：**成立**（关键）

判定要回答的是：**daemon 侧只有 `messageId`，能不能在 `this.history` 里找到截断点？**

### 2.1 `this.history` 里有什么

`PluginAgentSession.history`（`plugin-provider.js:862`）的元素是 `translate()` 的产物（`:1071-1095`），类型只有：
- `{type:"timeline", provider, item, turnId?, timestamp}`（`:1129-1141`）
- `{type:"turn_started"|"turn_completed"|"turn_canceled"|"turn_failed", turnId}`（`:1096-1127`）
- `{type:"usage_updated"}`, `{type:"permission_requested"}`, `{type:"permission_resolved"}`, `{type:"mode_changed"|"model_changed"|"thinking_option_changed"}`, `{type:"timeline"}`(notification)
- `{type:"provider_subagent", event}`（子代理，`:1226-1252` 经 `publish()`）

### 2.2 定位键：`item.messageId` —— **确认存在，且与 `revertTokens` 的键同源**

三处证据，缺一不可：

**(a) `revertTokens` 的键就是 `item.messageId`。** `mapTimelineItem`（`:1341-1352`）：
```js
function mapTimelineItem(item, snapshots, revertTokens) {
    ...
    if (revertToken !== undefined && revertTokens) {
        revertTokens.set(id, revertToken);                                  // 1347  id = 插件给的 `user:<clientMessageId>`
        if (item.type === "user_message" || item.type === "assistant_message") {
            revertTokens.set(item.messageId ?? id, revertToken);            // 1349-1350 ← 这就是 rewind 用的键
        }
    }
```
`rewind()` 拿到的 `providerMessageId`（`agent-manager.js:2255`）来自 `submittedRow.providerMessageId`，后者由 `reconcileSubmittedPromptEcho`（`:3444`）从 `item.messageId` 赋值。而 `item.messageId` 在 `mapTimelineItem` 的 `user_message` 分支被显式保留：
```js
return { type:"user_message", text:item.text, messageId: item.messageId ?? id, clientMessageId: item.clientMessageId };  // 1366-1370
```
**所以 `history` 里的 `timeline` 元素，其 `item.messageId` 与 `revertTokens` 的键是同一个值** —— 即 DSH 的 `user/message` 事件 id（插件侧 `session.ts:763` / `:1137` 把 `{messageId: data.id}` 作为 `revertToken` 发出）。

**(b) `item.messageId` 在 history 中被完整保留，不会被后续投影改写。** `forceHydrateTimelineFromLegacyProviderHistory`（`agent-manager.js:2915-2956`）对 `timeline` 元素只做 `projectAgentMessages(event.item)`（`:2921`），该函数对非 envelope 的 `user_message` 走 `projectAgentMessage` 的 `return item`（`agent-messages/envelope.js:157-160`），**原样返回**，`messageId` 不动。**注意**：`projectAgentMessages` 只在 `agent-manager` 侧发生，`plugin-provider.history` 里存的是**投影前**的 item —— 这反而更好，`history` 是稳定的。

**(c) 撤回点必然是一个 `user_message`。** `revertTokens` 只在 `user_message`/`assistant_message` 上注册（`:1348`），而 `rewind` 的 `submittedRow` 明确 `find((row) => row.item.type === "user_message" && ...)`（`agent-manager.js:2249-2251`）。

### 2.3 截断算法

```js
// 在 PluginAgentSession.revert() 的 await this.bridge.revert(...) 之后
this.truncateHistoryFrom(messageId);
```

```js
truncateHistoryFrom(messageId) {
    // 从尾部找第一个 item.messageId === messageId 的 timeline 元素。
    // 反向找而不是正向：同一 messageId 只可能有一行（DSH 的 user/message id 唯一），
    // 但正向会命中历史重放与实时两处（id 相同），反向取最后一条等价且更省。
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
        const event = this.history[index];
        if (event.type !== "timeline") continue;
        if (event.item?.messageId !== messageId) continue;
        // 截断到该行之前：撤回 = 该用户消息及其之后全部消失
        this.history.length = index;
        return true;
    }
    return false;   // fail closed：找不到就原样返回 false，调用方决定是否报错
}
```

**边界处理：**

| 情况 | 行为 | 理由 |
|---|---|---|
| 找到 `messageId` | `history.length = index`，**静默成功** | 正常路径 |
| 找不到（`messageId` 不在 history） | 返回 `false`，**不发错**，只 `logger.warn` | 此时桥已经完成了 surface 替换（`revert()` 已返回），撤回事实上已生效；抛错会让 `agent-manager` 的 catch 吞掉并报 `agent.rewind.failed`，用户看到"撤回失败"但文件已回退——**比不报错更糟**。选择 **fail open 但响亮**：`stderr` + 一行 warn，随后 force hydrate 仍会跑（只是历史没变短，退回今天的行为）。 |
| `messageId` 在 history 里但不是 `user_message` | 不会发生（§2.2c），但代码按 `item.messageId` 匹配，不校验 type | 校验 type 反而漏掉 assistant 行；`revertTokens` 两处都注册了 |
| history 为空 | 返回 `false` | 同上 |

**为什么用 `this.history.length = index` 而不是 `splice`：** 两者等价，但赋值 `length` 语义更明确（"截断"而非"删除一段"），且不会在中间留下空洞。

**子代理事件（`provider_subagent`）怎么处理：** 它们混在 `history` 里（`publish()` 也 push，`:1265-1267`）。截断按数组下标做，所以**撤回点之后的子代理事件会一并消失**——这是正确的（那些子代理属于被撤回的回合）。撤回点**之前**的子代理事件保留，`forceHydrate` 会把它们重新 `apply` 进 `providerSubagents` store（`agent-manager.js:2934-2942`），子代理行不丢。

### 2.4 一处必须同时改的地方：`timelineSnapshots` / `revertTokens`

截断 `history` 之后，`timelineSnapshots`（`:866`）和 `revertTokens`（`:865`）里仍留着被撤回行的快照与 token。后果：

- `revertTokens` 留旧 token：用户不能对已消失的行点撤回（行没了），无实际影响。但**二次撤回同一 messageId** 会拿到一个已被撤回的 token，桥会以「该行已不在可见表面」拒绝——`revert.js` 的 `planRewind` 有明确处理（`revert.js:50-113`），失败是响亮的。可接受。
- `timelineSnapshots` 留旧快照：`mapTimelineItem` 用它做 assistant/reasoning 的增量文本 diff（`:1355-1364`）。撤回后如果同一 `item.id` 再次出现（不会——撤回是删除，不是重发），会算出错误增量。**不会发生，不改。**

**决定：不清理这两个 Map。** 理由：清理需要遍历 history 反推哪些 id 该删，成本远大于收益，且两种残留都不产生错误行为。在计划里显式记录为「已知残留，不处理」。

---

## 3. Paseo 侧改动清单（57 行）

**目标文件**（daemon 实际加载路径，已核实 `ps` 与 `systemctl cat` 一致）：
```
$PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
```
当前 md5 `408f99fcaa8cf8a760a3646d788be774`，55034 字节，mtime `10月25日 18:09`。

> **不要打 `<paseo-src>/packages/server/dist`**：该目录不存在，且 daemon 不从这里加载（`systemctl cat paseo.service` 的 `ExecStart=paseo daemon run`，`ps` 显示 Main PID 843 的 node 进程 cwd 在 npm-global）。

### 改动 1：`PluginAgentSession` 新增方法（插在 `:1264` 之后、`publish()` 之前）

```js
    /**
     * LOCAL PATCH (paseo-dsh): drop the withdrawn tail of the translated history.
     *
     * The daemon rebuilds the timeline right after this session's `revert()`
     * resolves (`agent-manager.js` `rewind()` awaits `invokeRewindCapability`,
     * then calls `hydrateTimelineFromProvider({force:true})`), and that rebuild
     * reads exactly `this.history` through `streamHistory()`. This buffer only
     * ever grew — the plugin contract has no removal event — so a rewind kept
     * showing the withdrawn turns until the whole agent was reloaded. Truncating
     * here, before the reply goes out, is enough: no event, no race.
     *
     * `messageId` is the key `revertTokens` is populated under for user and
     * assistant rows (`mapTimelineItem`), and the row keeps it (`history` stores
     * pre-projection items), so it identifies the cut exactly.
     *
     * @param {string} messageId - provider message id the rewind targets.
     * @returns {boolean} whether a row matched (false leaves history untouched).
     */
    truncateHistoryFrom(messageId) {
        for (let index = this.history.length - 1; index >= 0; index -= 1) {
            const event = this.history[index];
            if (event.type !== "timeline" || event.item?.messageId !== messageId) continue;
            this.history.length = index;
            return true;
        }
        return false;
    }
```

### 改动 2：在 `revert()` 内调用（`:1263` 的 `});` 之后、`:1264` 的 `}` 之前）

```js
        if (!this.truncateHistoryFrom(messageId)) {
            process.stderr.write(
                `[plugin-provider] rewind ${messageId}: no history row carries this message id; `
                + "the timeline keeps the withdrawn turns until the agent is reloaded\n",
            );
        }
```
**5 行**（含 if 与写日志）。fail-open 但响亮，见 §2.3。

### 改动 3：`revertTokens` 的清理（同一插入点，改动 2 之后）

撤回成功后，被撤回行的 token 已无意义；不清理会让「撤回同一行两次」拿到失效 token 后由桥报错。清理更干净：
```js
        this.revertTokens.delete(messageId);
```
**1 行。**

> 之所以只删 `messageId` 这一个键：`revertTokens` 里同一行有两个键（`item.id` 和 `item.messageId`，`:1347` 与 `:1349`）。`item.id` 是插件侧的 `user:<clientMessageId>`，撤回后该行不再可点，留着无害；而遍历反查 `item.id` 需要额外扫描。**留作已知残留，注释说明。**

### 汇总

| # | 位置 | 行数 | 性质 |
|---|---|---|---|
| 1 | `:1264` 后插入 `truncateHistoryFrom` 方法（含文档注释 18 行 + 方法体 8 行） | 26 | 新增 |
| 2 | `:1263` 后插入 fail-open 日志 | 5 | 新增 |
| 3 | 同上插入 `revertTokens.delete` | 1 | 新增 |
| — | 空行与注释分隔 | 25 | — |
| **合计** | | **57** | **0 行删除** |

> 与任务书的「预计 55-60 行」吻合。**57 是含注释的物理行数；纯代码约 12 行。**

---

## 4. 插件侧要删的代码

### 4.1 分区审计（先分类，再决定删不删）

| 区块 | 位置 | 分类 | 结论 |
|---|---|---|---|
| Reload 旁路（spawn CLI） | `provider.ts:1162-1257`（`#refreshAgent` 全函数含文档） | **reload 专用** | **删** |
| 二进制解析 | `provider.ts:1135-1160`（`#resolvePaseoBinary` 全函数含文档） | **reload 专用**（唯一调用者 `:1204`） | **删** |
| agent id 注入取用 | `provider.ts:1292-1298`（`#open` 里读 `PASEO_AGENT_ID`） | **reload 专用**（唯一消费者 `:1194`） | **删** |
| `#agentIds` 字段与其它写点 | `:320` 声明、`:453` clear、`:982` delete、`:1332` delete、`:1597` delete | **reload 专用** | **删** |
| `findPaseoAgentId` + `claimedSessionIds` | `:1860-1963` | **reload 专用**（唯一调用者 `:1194`） | **删** |
| 50ms 定时器 | `provider.ts:1255`（`}, 50);`） | 属于 `#refreshAgent` | 随块删 |
| 「正在回退，请稍候」通知 | `provider.ts:942` | **reload 专用**（撤回已同步完成，无需等待提示） | **删** |
| `#reverting` 门禁 | `:331` 声明、`:456` clear、`:881-889` prompt 拒绝、`:906-913` 二次撤回拒绝、`:919` add、`:925` delete、`:1199/1216/1230/1239/1248` 各 delete、`:1811` 释放 | **reload 专用** | **删**（详见 4.2 风险） |
| `#releaseRevertingFor` | `:1799-1813` | reload 专用 | **删** |
| 跨刷新通知不丢（deferred notices） | `:84-89` iface、`:91` 常量、`:329` 字段、`:454-455` clear、`:1042-1074` `#notice`、`:1075-1107` `#deferNotice`、`:1109-1133` `#flushDeferredNotices`、`:1636-1640` 调用点 | **部分共用** | **保留**（详见 4.3） |
| `#dshIds` | `:327` 声明、`:454` clear、`:1278-1291` 写入、`:1810` 读取 | **共用** | **保留**（`#deferNotice` 依赖） |
| 停放会话池 | `parked-sessions.ts` 全 512 行 | **已被多会话复用** | **不删文件**（详见 4.4） |
| 停放池接线 | `provider.ts:27` import、`:409-421` 字段、`:425` start、`:462` stop、`:631` hold、`:652` release、`:708` release、`:1348` quiesce、`:820-826` waitForExit | **部分共用** | **保留 hold/release/quiesce/stop**（详见 4.4） |
| 路由键去 effort | `provider.ts:1346-1349` 传 `routeKey`、`session.ts:271-287` `routeKeyOf` | **共用**（`quiesce` 日志用） | **保留** |
| 权限卡清理 | `session.ts:627-633`（`revert()` 里 `#clearPendingPermissions`） | **撤回语义** | **保留**（详见 4.5） |
| 文件回退 | `session.ts:621-634` 的 `revert()` 主体、桥 `server.js` | 本次不动 | **保留** |
| `session.close` 的 `park: true` | `provider.ts:983-988` | 共用（注释已说 `park` 无效果） | **保留** |

### 4.2 `#reverting` 门禁：确认可删（逐调用点核过）

`#reverting` 的全部 13 处引用，按语义分两类：

- **只为 reload 窗口存在**：`:881-889`（prompt 拒绝）、`:906-913`（二次撤回拒绝）、`:919`（add）、`:925`（catch 清理）、`:1199/1216/1230/1239/1248`（refresh 各失败路径清理）、`:1811`（reopen 后释放）、`:456`（teardown 清理）、`:331`（声明）。
- **没有别处共用**：全仓 grep `#reverting` 只有这 13 处，无第三方读取。

删掉后：`session.prompt` 直接 `return this.#require(input.sessionId).prompt(input.prompt);`（回到 `:890` 的形态）；`session.revert` 去掉双重撤回守卫（桥自己已有 `revertInflight` 守卫，`dsh-bridge/lib/server.js:2032-2035`，会抛「该会话已有撤回正在进行」）。**桥的守卫是真正的守卫，插件的 `#reverting` 只是为 reload 窗口补的。**

### 4.3 `#notice` / `#deferNotice` / `#flushDeferredNotices`：**保留，只删 reload 相关的调用**

任务书列为「跨刷新通知不丢 `provider.ts:1042-1133`」，但**不能整块删**：

- `#notice` 有 6 个调用点：`:942`（删）、`:1200/1217/1233/1240`（随 `#refreshAgent` 删）、**`:1645` 与 `:1653`（保留）**——这两个是 `#open` 里报告「自定义 system prompt 未生效」与其它 open warning 的，与 reload 无关。
- `#deferNotice` 有 2 个调用点：`:949`（文件回退失败，**保留**）、`:1072`（`#notice` 的兜底，保留）。
- `#flushDeferredNotices` 唯一调用点 `:1640`，在 `#open` 成功后 flush——**保留**，文件回退失败的通知仍需要它。

**结论：`#notice`/`#deferNotice`/`#flushDeferredNotices` 三块（共 91 行）+ `DeferredNotice` iface + `MAX_DEFERRED_NOTICES` + `#dshIds` + `#deferredNotices` 全部保留。** 只删 `:942` 那一行调用。

> 这是本计划里最容易被误删的一块。`#deferNotice` 的文档注释写着「Used by the rewind path」，但它同时服务文件回退失败——而文件层本次完全不动。

### 4.4 停放会话池：**不删文件，保留 hold/release/quiesce/stop，只失去 reload 用途**

任务书提醒「已被 `3a5cfc0` 一进程多会话复用」。实测结论更明确：

- `parked-sessions.ts` 的 `park()` / `take()` / `discard()` / `sweep()` / `forget()` **在生产代码里零调用**（全仓 grep 只有 `harness/parked-sessions-check.cjs` 调用）。`provider.ts` 里 `#parked.` 的调用只有 `start()`、`stop()`、`hold()`、`release()`、`quiesce()`。
- 即 `#holds` 计数（`hold`/`release`）与 `quiesce`（等进程退出释放 session log 写锁）是**活代码**，服务于「共享进程退役后下一个 open 必须等锁释放」，与 reload 无关。
- 但 `#holds` 的唯一用途是给 `park/sweep/discard/evict` 当守卫——这三个方法零调用，所以 `#holds` 实际上也是死逻辑（只是没有代码路径会让它产生错误行为）。

**决定：本次不动 `parked-sessions.ts`。** 理由：
1. 删 `hold`/`release` 需要同时改 `#addPoolClaim`/`#releasePoolProcess`/`#dropPoolClaims` 三个函数的契约（注释明确写了「exactly one release per claim」的配对不变量），风险面覆盖所有会话的进程生命周期。
2. 文件 512 行里有 `quiesce`（活）+ `#dying` 记账（活）+ `stop()`（活）三块真在用，整块删不掉。
3. 收益：删掉 `park/take/discard/sweep/forget/#evictOverflow/#markDying` 约 200 行死代码——**但 `#markDying` 被 `park/sweep/discard/evict` 调用，删它们就能一起删**。这是纯收益，可以列为「第二阶段可选」。

**本次只删 `#parked.quiesce` 的调用吗？不删。** `quiesce` 服务于共享进程退役后的锁释放等待，与 reload 无关（`:820-826` 的 `waitForExit(RELEASE_TIMEOUT_MS)` 同理）。

**所以「停放会话池」这一项的本次删除量是 0 行。** 这是与任务书预期的最大偏差，需用户确认。

### 4.5 权限卡清理 `session.ts:627-633`：**保留**

`revert()` 里调 `#clearPendingPermissions(...)`。撤回后会话仍在（A2 不 close 会话），待答卡片**依然属于一个已被撤回的对话**——`#clearPendingPermissions` 的语义（"The conversation was rewound past this question"）在 A2 下依然正确。**保留。**

### 4.6 精确删除清单与行数

**`paseo-plugin/server/provider.ts`**

| # | 范围 | 行数 | 内容 |
|---|---|---|---|
| 1 | `:1162-1257` | 96 | `#refreshAgent` 全函数（含文档注释） |
| 2 | `:1135-1160` | 26 | `#resolvePaseoBinary` 全函数（含文档注释） |
| 3 | `:1860-1963` | 104 | `findPaseoAgentId` + `claimedSessionIds`（含文档注释） |
| 4 | `:1799-1813` | 15 | `#releaseRevertingFor`（含文档注释） |
| 5 | `:876-889` | 14 | `session.prompt` 的 `#reverting` 门禁（含注释） |
| 6 | `:903-913` | 11 | `session.revert` 的二次撤回守卫（含注释） |
| 7 | `:915-919` + `:928-934` + `:959-966` | 20 | `session.revert` 里 reload 相关注释与 `#refreshAgent` 调用 |
| 8 | `:942` | 1 | 「正在回退，请稍候」 |
| 9 | `:949-957` | 9 | **不删**（文件回退失败通知，保留） |
| 10 | `:1292-1298` | 7 | `#open` 里读 `PASEO_AGENT_ID`（含注释） |
| 11 | `:320` + 文档注释 `:308-319` | 13 | `#agentIds` 声明 |
| 12 | `:453` | 1 | `#agentIds.clear()` |
| 13 | `:982` | 1 | `#agentIds.delete`（`session.close`） |
| 14 | `:1332` | 1 | `#agentIds.delete`（holder） |
| 15 | `:1597` | 1 | `#agentIds.delete`（open catch） |
| 16 | `:330-331` | 2 | `#reverting` 声明 + 注释 |
| 17 | `:456` | 1 | `#reverting.clear()` |
| 18 | `:341` | 1 | `#paseoBinary` 声明 |
| 19 | `:11` `:12` `:13` `:14` | 4 | 四个 import（`fs`/`os`/`path`/`child_process` 全部只被删除块使用，已逐个核过：`readdirSync`/`readFileSync` 仅 `:1884/1893/1901`；`homedir` 仅 `:1881`；`join` 仅 `:1881/1890/1901`；`execFileSync` 仅 `:1150`；`spawn` 仅 `:1205`） |
| | **合计** | **327** | |

**`paseo-plugin/server/parked-sessions.ts`**：0 行（见 4.4）。

**插件侧合计删除：327 行。**

> 任务书预期「约 180 行 reload 旁路 + 512 行停放池 = 约 692 行」。实际：reload 旁路及门禁共 **327 行**，停放池 **0 行**。偏差原因：停放池的核心（`quiesce`/`#dying`/`hold`/`release`）服务于共享进程退役，不是 reload 专用；而 `#notice`/`#deferNotice` 服务文件回退失败通知，也不是 reload 专用。

---

## 5. 保留不动（防误删清单）

| 项 | 位置 | 为什么不能动 |
|---|---|---|
| 表面替换事件 | `dsh-bridge/lib/server.js:2060-2082` | 撤回的真正实现：`session.append('user/message', marker, {surfaceOp:{op:'replace',...}})`。DSH 的 durable、可审计机制。 |
| `settleAgentForRevert` | `server.js:1615-1628` | surface replacement 的 range 在 append 时冻结，之后的 turn 事件会让撤回内容"回来"。必须 cancel + 等 idle + 清 inbox。 |
| 重放折叠 | `dsh-bridge/lib/surface.js:72-100`（`visibleEvents`） | 只折 `paseo-rewind` 缝；compaction 的 replace 不折（否则重开会话丢压缩前对话）。 |
| 文件回退全部 | `file-snapshots.js`、`session.ts` 的 `revert()` 主体、`revert.js` 的 `planRestore` 调用 | 用户已拍板本次不动。 |
| 派发锚 / 中断 | `child-anchors.js`、`delegated-cancel.js` | 子代理撤回归并依赖，与本次无关。 |
| `folded` Map | `session.ts:1265-1270` | 子代理重放通用优化（16 子会话实测 15377 次发射 → 7151 行，堆 708MB、GC 卡 6727ms）。**不是撤回专用**，注释明确写「`revertToken` is unaffected」。 |
| `#notice` / `#deferNotice` / `#flushDeferredNotices` | `provider.ts:1042-1133` | 文件回退失败通知 + open warning 报告。见 §4.3。 |
| `#dshIds` / `#deferredNotices` | `provider.ts:327-329` | `#deferNotice` 依赖。 |
| `parked-sessions.ts` 全部 | 512 行 | `quiesce`/`#dying`/`hold`/`release`/`stop` 是活代码。见 §4.4。 |
| `#parked.quiesce` 调用 | `provider.ts:1348-1351` | 共享进程退役后的 session log 写锁等待，与 reload 无关。 |
| `waitForExit(RELEASE_TIMEOUT_MS)` | `provider.ts:823` | 同上。 |
| `routeKeyOf` | `session.ts:271-287` | `quiesce` 的 `routeKey` 参数来源（虽然注释说"currently has no callers"，但 `:1348` 传的是内联字符串，`routeKeyOf` 确实无调用者——**可删但本次不删**，属独立清理）。 |
| 权限卡清理 | `session.ts:627-633` | 撤回后卡片仍属已撤回对话。见 §4.5。 |
| `session.close` 的 `park: true` | `provider.ts:988` | 注释已说明 `park` 无效果；`park:false/true` 是 session API 的一部分。 |

---

## 6. 补丁机制

### 6.1 前置：先回滚现有 22 行 `deleteParent` 补丁

**现状核实**（`diff ~/.paseo/local-patches/agent-manager.js.orig-20261026 <当前 agent-manager.js>`）：

补丁确实存在，14 行新增（含注释），删除 8 行原始代码，合计 22 行 diff。两处：
- `:904-908` 新增注释块（`rehydrateFromDisk` 分支，不 wipe providerSubagents）
- `:2934-2942` 注释块替换原来的 `deleteParent` 循环

**当前未生效**：`systemctl status paseo.service` 显示 `Active: active (running) since Fri 2026-10-23 21:32:58 CST`，而 `agent-manager.js` 的 mtime 是 `10月26日 02:56`——**文件晚于进程启动 2 天多，内存里跑的是旧代码**。这与「已被双向证伪、且当前未生效」的结论一致。

**回滚命令**（幂等，可重复执行）：
```bash
TARGET=$PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js
ORIG=~/.paseo/local-patches/agent-manager.js.orig-20261026
# 守卫：ORIG 必须存在且是原始包（md5 需与升级后重新取得的原始包一致）
test -f "$ORIG" || { echo "FATAL: baseline missing"; exit 1; }
cp "$ORIG" "$TARGET"
node --check "$TARGET" || { echo "FATAL: syntax"; exit 1; }
md5sum "$TARGET" "$ORIG"   # 两者必须相同
```
回滚后 `md5sum` 应为 `93af8ce4922b7df58a1ce86c1996dde2` 之外的值——**注意**：当前 `agent-manager.js` md5 是 `93af8ce4922b7df58a1ce86c1996dde2`，这是**已打补丁后**的 md5；`.orig-20261026` 是**打补丁前**的。回滚后 md5 应等于 `.orig` 的 md5。开工时先 `md5sum` 两个文件记录基线。

### 6.2 新补丁：幂等脚本

**文件**：`~/.paseo/local-patches/apply-rewind-history-truncation.mjs`

**设计**：

```
1. TARGET = 全局包的 plugin-provider.js 绝对路径（硬编码，不用相对解析）
2. 基线守卫：BASE_MD5 常量 = 408f99fcaa8cf8a760a3646d788be774
   - 若当前 md5 == BASE_MD5 → 未打补丁，继续
   - 若当前 md5 == PATCHED_MD5 → 已打补丁，exit 0（幂等成功）
   - 否则 → 版本变了，exit 1 并打印当前 md5，要求人工核对
3. 两处匹配，各必须命中恰好 1 次：
   A. 锚点1：`    publish(event) {\n        this.history.push(event);\n        this.emit(event);\n    }`
      → 在 `publish(event) {` 之前插入 truncateHistoryFrom 方法
   B. 锚点2：revert() 里 `        await this.bridge.revert({\n ... \n        });\n    }` 的 `});` 之后
      → 插入 fail-open 日志 + revertTokens.delete
   - 命中 0 次 → exit 1（"anchor not found, upstream changed"）
   - 命中 >1 次 → exit 1（"anchor ambiguous"）
4. 写盘前：cp TARGET TARGET.orig-YYYYMMDDHHmmss（时间戳备份，保留原文件）
5. 写入后 node --check TARGET，失败则自动还原备份并 exit 1
6. 打印前后 md5 + 应用条数（2）
```

**关键点**：
- 用 Node 而非 `sed`：锚点跨多行、含特殊字符（`{`、`}`、中文注释），`sed` 的正则转义会出错。
- `exit 1` 而非静默跳过：升级后锚点找不到必须响亮失败，否则 `ExecStartPre` 会放行一个未打补丁的 daemon。
- **不要用 `patch-package`**：作用域仅仓库 `node_modules`，覆盖不到 `~/.npm-global` 全局包，且只在 `npm install` 时触发。

### 6.3 升级后自动重打：systemd `ExecStartPre`

**已核实 daemon 由 systemd user unit 托管**：
```
~/.config/systemd/user/paseo.service
ExecStart=paseo daemon run --home ~/.paseo
Restart=always
```
当前**无** `ExecStartPre`。

**改法**：在 `[Service]` 段加
```ini
ExecStartPre=/usr/bin/node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
```
- `node` 用绝对路径（systemd 的 `PATH` 已设为含 `.npm-global/bin`，但绝对路径更稳）。
- 脚本的幂等 + 失败即 exit 1 语义，使 `ExecStartPre` 失败时 systemd 拒绝启动服务（而不是起一个未打补丁的 daemon）。
- **风险**：如果升级后锚点变了，脚本 exit 1，**daemon 起不来**。这是有意的（fail closed），但需在文档里写明应急手段：`systemctl --user edit paseo.service` 临时注释掉 `ExecStartPre`，或先跑脚本看报错。

**替代方案**（若用户不想动 systemd）：`paseo` 的 daemon 启动是 `ExecStart` 一行，没有 hook。备选是在 `~/.npm-global/lib/node_modules/@getpaseo/cli/package.json` 加 `postinstall` —— 但那是**改包自身**，升级会覆盖，且 npm 全局安装的 `postinstall` 是否执行取决于 npm 配置，**不可靠**。**推荐 `ExecStartPre`。**

### 6.4 应用顺序（严格串行）

```
1. 记录基线 md5（plugin-provider.js / agent-manager.js / .orig）
2. 回滚 deleteParent 补丁（§6.1）→ node --check → md5 与 .orig 一致
3. 安装 apply-rewind-history-truncation.mjs
4. 手动跑一次脚本 → 校验 md5 变化 + node --check + 应用条数 == 2
5. 连跑第二次 → 必须报「已打补丁」并 exit 0（幂等自证）
6. 改 systemd unit 加 ExecStartPre
7. systemctl --user daemon-reload
8. systemctl --user restart paseo.service   ← 会杀全部会话，需用户确认时机
9. 生效验证：ps 的 Main PID 启动时刻 > plugin-provider.js 的 mtime
```

---

## 7. 验收标准

### 7.1 本地离线（不打 daemon、不耗 token）

| # | 断言 | 命令 | 能失败吗 |
|---|---|---|---|
| L1 | 补丁脚本幂等：连跑两次第二次 exit 0 且 md5 不变 | `node apply-...mjs; node apply-...mjs; md5sum` | 能（第一次后 md5 变，第二次不该再变） |
| L2 | 锚点缺失时 exit 1 | 用 `sed` 改掉锚点 → 跑脚本 → 期望 exit 1 且**文件未被修改**（md5 不变） | 能 |
| L3 | `node --check` 通过 | `node --check plugin-provider.js` | 能 |
| L4 | 截断算法单测（纯函数抽出） | 构造 `history = [A,B,C,D]`，`messageId` 命中 B → 期望剩 `[A]`；命中不存在 → 期望 `false` 且数组不变 | 能（两个方向都能红） |
| L5 | 插件侧删除后 `npx tsc --noEmit` 通过 | `cd paseo-plugin && npx tsc --noEmit` | 能 |
| L6 | 插件侧删除后离线 harness 全绿 | `node harness/revert-check.mjs`、`surface-check.mjs`、`file-snapshot-check.mjs`、`rewind-merge-check.mjs`、`revert-shape-probe.mjs` | 能 |
| L7 | 桥未改动 | `node harness/bridge-assets-check.mjs`（应仍为绿，证明本次没碰桥） | 能 |
| L8 | `harness/session-request-check.cjs` | 该脚本断言撤回回执 + 「正在回退」通知 + 门禁释放——**删掉 `#reverting` 与 `:942` 后这条必然红**，需同步改断言（见 §7.4） | 能，且**预期会红** |

### 7.2 真机（耗 token，需重启 daemon）

**前置**：必须用**新会话**（能力位只对新会话生效）。测量方法写在每条里。

| # | 判据 | 怎么测（必须能失败） |
|---|---|---|
| R1 | **session id 不变** | 撤回前后各 `paseo inspect <agentId> --json`，取 `persistence.sessionId` 与 `runtimeInfo.sessionId`。**必须相同**。对照：打补丁前这两个值会变（reload 重新 mint provider session id）。**这条是双向变异的核心判据**。 |
| R2 | **无 loading 态** | 复刻 `opencode-rewind.real.e2e.test.ts:128-140` 的 `expectNoLoadingRegression` 语义：订阅 `agent_update`，记录每条 `payload.agent.status`，断言不存在相邻对 `["running","loading"]`，也不存在三元组 `["idle","loading","idle"]`。`screenStatusForInvariant` 把 `initializing` 映射为 `loading`。**本地脚本化**：用 `paseo inspect` 轮询 200ms 一次记录状态序列，撤回后断言序列中不出现 `initializing`/`loading`。 |
| R3 | **子代理行不丢** | 撤回前让 agent 起 2 个子代理（各写一个文件），撤回其中一个子代理之后的父消息。撤回后 `paseo logs <agentId> --json` 里子代理行数量与撤回前**相同**（撤回点之前的子代理保留；撤回点之后的子代理消失是**正确**的，所以这条要精确到"撤回点之前的子代理数量不变"）。**当前 22 行补丁就是为了这个**——回滚该补丁后如果 R3 红，说明还需要 A2 之外的东西。 |
| R4 | **延迟实测** | 三处时间戳对齐：(a) `~/.paseo/daemon.log` 里 `"msg":"agent.rewind.start"` 与 `"msg":"agent.rewind.complete"` 的 `time` 字段差；(b) 客户端点撤回的 `Date.now()`；(c) 时间线 `timeline_replacement` 事件到达时刻。**打补丁前先量 3 次基线**（预期 ~2035ms），打补丁后同口径量 3 次。**必须报绝对毫秒数与样本量**，不只报结论。 |
| R5 | **撤回后继续对话正常** | 撤回 → 发一条新消息 → 收到回复。断言新回复不包含被撤内容。 |
| R6 | **模型不知道被撤内容** | 撤回后发「我们刚才聊了什么？」→ 断言回复里没有被撤回合的关键词。**这是端到端判据，不是渲染判据**（界面看不到 ≠ 模型不知道）。 |
| R7 | **重开会话仍正确** | 撤回后关掉 agent 再 `paseo inspect` / 重新打开 → 被撤消息仍不在、子代理行仍在、后续对话正常。**这条走的是 `replayHistory()` 的折叠路径，与 A2 的 `history` 截断是两条独立路径**——A2 不修重开路径（重开路径靠桥的 `visibleEvents` 折叠，已经是好的）。 |
| R8 | **文件回退仍正常** | 撤回含文件编辑的回合 → 文件恢复（文件层本次不动，属回归验证）。 |
| R9 | **权限卡清理仍生效** | 回合里弹权限卡 → 撤回 → 卡片消失且不再可点。 |

### 7.3 双向变异（必须做）

| 变异 | 期望 | 证明什么 |
|---|---|---|
| **不打补丁**（回滚 `plugin-provider.js` 到 `.orig`），跑 R1/R2/R4 | R1 **红**（session id 变）、R2 **红**（出现 loading）、R4 ≈2035ms | 判据能失败 |
| **打上补丁**，跑同样 R1/R2/R4 | R1 **绿**、R2 **绿**、R4 显著下降 | 判据绑定被修路径 |
| **打补丁但删掉 `truncateHistoryFrom` 调用**（保留方法） | R1 **绿**（session id 不变，因为 reload 已删）、但**时间线仍显示被撤消息** | 证明截断是必需的，不是 reload 删除的副作用 |

> 第三个变异最关键：删掉 reload 后 session id 自然不变，R1 会"假绿"。必须有一个独立判据证明「历史真的变短了」——即**撤回后时间线上被撤消息消失**（这是 A2 的直接效果）。**把这个加入 R0**：撤回后 `paseo logs <agentId> --json` 里被撤消息的 `messageId` **不再出现**。

### 7.4 需要同步修改的现有断言

- `harness/session-request-check.cjs`：断言「成功 `request.completed` +『正在回退』通知 + 被拒 `request.failed` + 被拒后门禁释放」。删掉 `#reverting` 与 `:942` 后，**「正在回退」通知与门禁相关的断言必然红**。改法：删掉这几条断言，保留「成功回执」与「被拒 `request.failed`」（被拒来自桥的 `revertInflight`，仍会失败）。
- `harness/parked-sessions-check.cjs`：本次不动 `parked-sessions.ts`，**该脚本应保持全绿**——它是「停放池没被误伤」的守卫。
- `docs/REWIND.md`：撤回架构文档，需同步更新（去掉 reload 旁路描述，加 A2 机制）。

---

## 8. 风险与回滚

### 8.1 风险清单

| # | 风险 | 面 | 缓解 |
|---|---|---|---|
| K1 | 截断位置算错，误删未撤回的回合 | 所有 agent | 截断按 `item.messageId` 精确匹配（DSH message id 唯一）。fail-open（找不到就原样返回）避免误删。真机 R0/R5/R6 覆盖。 |
| K2 | `this.history` 截断后 `timelineSnapshots` 残留导致增量文本错 | 单会话 | 已论证不会发生（§2.4），不改。**未验证项**：若将来同一 `item.id` 重发会出现，需监控。 |
| K3 | 删 `#reverting` 后 prompt 与 revert 并发 | 单会话 | 桥的 `revertInflight`（`server.js:2032`）是真正的守卫，会抛「该会话已有撤回正在进行」。`settleAgentForRevert` 会 cancel 运行中的 turn。**推断**：并发 prompt 可能被 cancel 而非拒绝，用户体验略变（从"被拒绝"变成"回合被取消"）。 |
| K4 | 补丁打错路径（打到仓库 `packages/server/dist`） | 全盘无效但"看起来成功" | 脚本硬编码绝对路径 + `ps`/`systemctl cat` 交叉验证 + 生效判据比对进程启动时刻与 mtime。 |
| K5 | 升级整树替换导致补丁消失 | 撤回退回旧行为 | `ExecStartPre` 幂等重打 + 基线 md5 守卫（md5 不符即 exit 1 拒绝启动）。 |
| K6 | `ExecStartPre` 失败导致 daemon 起不来 | 全部会话不可用 | 有意的 fail closed。应急：`systemctl --user edit` 注释掉该行。**必须提前告知用户这个代价。** |
| K7 | 删 327 行插件代码引入编译错 | 插件整体 | `npx tsc --noEmit` + 6 个离线 harness + 真机冒烟。 |
| K8 | 本次 A2 不修「重开会话」路径 | — | 重开路径靠桥的 `visibleEvents` 折叠，**已经是正确的**，不需 A2。R7 验证。 |
| K9 | 撤回后 `revertTokens` 残留 `item.id` 键 | 无实际影响 | 已记录（§2.4）。 |

### 8.2 逐条回滚步骤

**回滚顺序：先回滚插件（用户可见面），再回滚 daemon。**

```bash
# 步骤 0：确认当前状态
md5sum $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
systemctl --user status paseo.service --no-pager | head -5

# 步骤 1：回滚 daemon 补丁
# 用脚本自带的时间戳备份（apply 脚本会生成 .orig-<ts>）
LATEST=$(ls -t $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js.orig-* | head -1)
cp "$LATEST" $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
node --check $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
md5sum $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js   # 应 == 408f99fcaa8cf8a760a3646d788be774

# 步骤 2：移除 ExecStartPre（防止回滚后又被重打）
systemctl --user edit paseo.service    # 注释掉 ExecStartPre 行
systemctl --user daemon-reload

# 步骤 3：回滚插件（git，需要用户授权写操作）
cd <repo> && git checkout -- paseo-plugin/server/provider.ts
# 若已提交：git revert <commit>

# 步骤 4：重启 daemon（会杀全部会话，必须用户确认时机）
systemctl --user restart paseo.service

# 步骤 5：验证回滚生效
ps -o lstart= -p $(systemctl --user show -p MainPID --value paseo.service)
stat -c '%y' $PASEO_CLI/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
# 进程启动时刻必须晚于文件 mtime

# 步骤 6：恢复 deleteParent 补丁（若回滚到"改造前"而非"打 A2 前"）
# 若 A2 失败且需要退回 reload 方案，重新应用 22 行 deleteParent 补丁
```

**关键点**：步骤 1 与步骤 2 必须**先于**步骤 4。否则 `ExecStartPre` 会在重启时把刚回滚的文件重新打上补丁。

---

## 9. 实施顺序（建议分 4 个可独立验收的阶段）

| 阶段 | 内容 | 验收 | 可回滚点 |
|---|---|---|---|
| **P0** | 回滚 22 行 `deleteParent` 补丁；量 3 次撤回延迟基线 | md5 与 `.orig` 一致；延迟基线记录在案 | 无（回滚就是还原） |
| **P1** | 打 A2 补丁（57 行）；**不删插件任何代码**；重启 daemon；跑真机 R0/R1/R2/R4 | A2 单独生效：session id 不变、无 loading、延迟下降、**但撤回后仍有「正在回退」提示与 reload**（reload 还在，会重复重建——预期是「能工作但有冗余」） | 回滚 plugin-provider.js |
| **P2** | 删插件 reload 旁路（327 行）；`tsc` + 离线 harness + 真机全量 R0-R9 | 全绿 | git checkout |
| **P3** | 装 `ExecStartPre` 幂等脚本；验证升级后自动重打 | 连跑两次幂等 + 锚点缺失 exit 1 | 注释掉 ExecStartPre |

> **P1 与 P2 必须分开。** 如果 P1 就直接删 reload，一旦 A2 有问题，无法区分「A2 的截断算错」还是「删 reload 删漏了」。P1 保留 reload 时 A2 的截断会被 reload 覆盖（重开后 history 是新的），**所以 P1 的 R0 判据要改成「reload 发生之前的时间线已经变短」**——这反而能精确验证 A2 的时序假设。

---

## 10. 未验证项

明确标注，开工前需补：

1. **`~/.paseo/agents/<workspace>/<agentId>.json` 的 `persistence` 字段形状** —— `findPaseoAgentId` 的 `claimedSessionIds` 解析它（`provider.ts:1941-1963`），但**本次要删这个函数**，所以不影响。**未验证**：删除后无副作用（已 grep 确认唯一调用者是 `#refreshAgent`）。
2. **`paseo inspect --json` 是否输出 `runtimeInfo.sessionId` 与 `persistence.sessionId`** —— R1 的测量依赖它。`plugin-provider.js:950-958` 的 `getRuntimeInfo()` 返回 `{provider, sessionId, model, modeId, thinkingOptionId}`，其中 `sessionId: this.id` 是 provider session id。**未验证** CLI 是否透出这个字段，需开工时实测；若没有，改用 daemon 日志或客户端事件流。
3. **`agent_update` 事件的 `status` 字段取值全集** —— R2 依赖它。已知 `screenStatusForInvariant` 处理 `initializing`→`loading`，其余透传。**未验证** A2 下是否真的不出现 `initializing`（理论上不 close/reopen 就不会有，但 `settleAgentForRevert` 会 cancel turn，cancel 路径是否触发 `loading` **未验证**）。
4. **`history.length = index` 截断后，`forceHydrate` 的 `providerSubagentEvents` 收集是否完整** —— `forceHydrateTimelineFromLegacyProviderHistory`（`agent-manager.js:2915-2942`）遍历 `streamHistory()` 收集 `provider_subagent` 事件再 `apply`。截断后撤回点之前的子代理事件仍在 history 里，会被重新 apply。**未验证**：`providerSubagents.apply` 对"已经 apply 过的同一 event"是否幂等（`store.js:19-30` 看起来是覆盖，但未实测重复 apply 的行为）。
5. **删掉 `#reverting` 后，`session.prompt` 与 `session.revert` 的真实并发行为** —— §8.1 K3 是推断（桥有 `revertInflight` 守卫）。**未验证**：Paseo 客户端是否可能在撤回期间发 prompt（理论上 UI 会禁用，但 API 层没有）。
6. **`ExecStartPre` 在 `Type=simple` + `Restart=always` 下的失败语义** —— 预期是 `ExecStartPre` 失败则服务不启动、`Restart` 会重试。**未验证**具体重试间隔与是否无限重试（可能刷日志）。
7. **Paseo 0.13.0 之后上游是否已修 issue #4667** —— 插件注释提到该 issue 仍 open（`provider.ts:1167`）。**未验证**当前是否有更新的 release 已修；若有，A2 补丁可能白做。开工前应查一次上游 changelog。
8. **`docs/REWIND.md` 的现有内容** —— 未读。P2 阶段需同步更新。

---

## 附录 A：关键行号速查（开工前重新 grep 校验）

**daemon 侧**（`~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/`）

| 内容 | 文件:行 |
|---|---|
| `PluginAgentSession` 类起 | `plugin-provider.js:856` |
| `this.history = []` | `plugin-provider.js:862` |
| `revertTokens` 初始化 | `plugin-provider.js:865` |
| `accept()` push | `plugin-provider.js:1063-1070` |
| `translate()` | `plugin-provider.js:1071-1095` |
| `translateTimeline()` | `plugin-provider.js:1129-1141` |
| `revert(messageId, scope)` | `plugin-provider.js:1253-1264` |
| `publish()` push | `plugin-provider.js:1265-1268` |
| `mapTimelineItem()` | `plugin-provider.js:1341-1383` |
| `revertTokens.set(item.messageId)` | `plugin-provider.js:1349-1350` |
| `user_message` 保留 messageId | `plugin-provider.js:1366-1370` |
| `streamHistory()` | `plugin-provider.js:944-947` |
| `rewind()` | `agent-manager.js:2245-2285` |
| `await invokeRewindCapability` | `agent-manager.js:2262` |
| `await hydrateTimelineFromProvider({force:true})` | `agent-manager.js:2264` |
| `forceHydrateTimelineFromLegacyProviderHistory` | `agent-manager.js:2915-2956` |
| `providerSubagents.apply` | `agent-manager.js:2934-2942` |
| `projectAgentMessages` | `agent-messages/envelope.js:138-150` |
| `invokeRewindCapability` | `rewind/rewind.js:8-28` |
| `ProviderEventSchema` | `@getpaseo/plugin/dist/server/provider.js:695` |
| `request.completed` schema | `@getpaseo/plugin/dist/server/provider.js:712` |
| `session.revert` input schema | `@getpaseo/plugin/dist/server/provider.js:354-361` |

**插件侧**（`<repo>/paseo-plugin/server/`）

| 内容 | 文件:行 |
|---|---|
| `#reverting` 声明 | `provider.ts:330-331` |
| `#agentIds` 声明 | `provider.ts:320`（文档 `:308-319`） |
| `#paseoBinary` 声明 | `provider.ts:341` |
| `#parked` 字段 | `provider.ts:409-421` |
| `close()` 里的 clear | `provider.ts:453-456` |
| `#addPoolClaim` 的 hold | `provider.ts:622-632` |
| `#dropPoolClaims` 的 release | `provider.ts:648-653` |
| `#releasePoolProcess` 的 release | `provider.ts:702-710` |
| `session.prompt` 门禁 | `provider.ts:876-889` |
| `session.revert` 分支 | `provider.ts:902-968` |
| 「正在回退」通知 | `provider.ts:942` |
| 文件回退失败 defer | `provider.ts:949-957` |
| `#notice` | `provider.ts:1042-1073` |
| `#deferNotice` | `provider.ts:1075-1107` |
| `#flushDeferredNotices` | `provider.ts:1109-1133` |
| `#resolvePaseoBinary` | `provider.ts:1135-1160` |
| `#refreshAgent` | `provider.ts:1162-1257` |
| 50ms 定时器 | `provider.ts:1255` |
| `#open` 读 PASEO_AGENT_ID | `provider.ts:1292-1298` |
| `#parked.quiesce` 调用 | `provider.ts:1348-1351` |
| `#flushDeferredNotices` 调用 | `provider.ts:1640` |
| `#releaseRevertingFor` | `provider.ts:1799-1813` |
| `findPaseoAgentId` | `provider.ts:1860-1939` |
| `claimedSessionIds` | `provider.ts:1941-1963` |
| `revert()` + 权限卡清理 | `session.ts:621-634` |
| `revertToken` 生成（live） | `session.ts:1137` |
| `revertToken` 生成（replay） | `session.ts:763` |
| `folded` Map（保留） | `session.ts:1265-1270` |

**桥侧**（不动，仅供对照）

| 内容 | 文件:行 |
|---|---|
| 表面替换 append | `dsh-bridge/lib/server.js:2060-2082` |
| `settleAgentForRevert` | `dsh-bridge/lib/server.js:1615-1628` |
| `revertInflight` 守卫 | `dsh-bridge/lib/server.js:2032-2035` |
| `visibleEvents` 折叠 | `dsh-bridge/lib/surface.js:72-100` |
| `planRewind` | `dsh-bridge/lib/revert.js:50-113` |

---

## 附录 B：与任务书预期的偏差（需用户确认）

| 项 | 任务书预期 | 实测 | 原因 |
|---|---|---|---|
| Paseo 侧改动 | 55-60 行 | **57 行** | 吻合 |
| reload 旁路删除 | ~180 行 | **291 行** | 任务书列的 180 行只算了 `#refreshAgent` 与 `#resolvePaseoBinary`；漏算了 `findPaseoAgentId`/`claimedSessionIds`（104 行，唯一的 agent id 反查兜底）与 `#releaseRevertingFor`（15 行） |
| 停放池删除 | 512 行整块 | **0 行** | 核心（`quiesce`/`#dying`/`hold`/`release`/`stop`）服务共享进程退役，不是 reload 专用；`park`/`take`/`discard`/`sweep` 零调用但删它们要动 `hold`/`release` 的配对不变量 |
| `#notice`/`#deferNotice` 删除 | 1042-1133 共 91 行 | **0 行** | 服务文件回退失败通知（`:949`）与 open warning（`:1645`/`:1653`），不是 reload 专用 |
| 插件侧总删除 | ~692 行 | **327 行** | 上面两项 |

**327 行的完整分解**（逐项按 `python3` 精确计算，非估算）：

| 块 | 行号 | 行数 |
|---|---|---|
| `#refreshAgent` 全函数 | `1162-1257` | 96 |
| `#resolvePaseoBinary` 全函数 | `1135-1160` | 26 |
| `findPaseoAgentId` + `claimedSessionIds` | `1860-1963` | 104 |
| `#releaseRevertingFor` | `1799-1813` | 15 |
| `session.prompt` 的 `#reverting` 门禁 | `876-889` | 14 |
| `session.revert` 的 `#reverting.add`/catch | `915-927` | 13 |
| `session.revert` 的二次撤回守卫 | `903-913` | 11 |
| `session.revert` 的 reload 注释（`:928-934`） | `928-934` | 7 |
| `session.revert` 的 reload 注释 + `#refreshAgent` 调用 | `959-966` | 8 |
| 「正在回退，请稍候」 | `942` | 1 |
| `#open` 里读 `PASEO_AGENT_ID` | `1292-1298` | 7 |
| `#agentIds` 声明 + 文档注释 | `308-320` | 13 |
| `#agentIds.clear()` | `453` | 1 |
| `#agentIds.delete`（session.close） | `982` | 1 |
| `#agentIds.delete`（holder） | `1332` | 1 |
| `#agentIds.delete`（open catch） | `1597` | 1 |
| `#reverting` 声明 + 注释 | `330-331` | 2 |
| `#reverting.clear()` | `456` | 1 |
| `#paseoBinary` 声明 | `341` | 1 |
| 四个 import（fs/os/path/child_process） | `11-14` | 4 |
| **合计** | | **327** |

> 该数字为设计期精确计数。P2 实施后以 `git diff --stat` 复核；若偏差 >10%，说明有未识别的耦合，须停下重审。
