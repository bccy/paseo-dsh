# 撤回原生化（A2）实施进度

> **历史文档，内容保持当时原样。** 文中提到的 `paseo-plugin/server/parked-sessions.ts`（含 `harness/parked-sessions-check.cjs`）已在 `bf093a7` 删除——它的 `hold`/`release`/`quiesce`全是空壳，共享进程的引用计数已收回 `provider.ts` 的 `#poolClaims`。

> 计划：`docs/PLAN-REWIND-NATIVE.md`
> 最后更新：2026-10-26 05:35（P0/P1/P2/P3 全部完成并验收）

## 结论

**A2 已落地并完成双向变异自证。** 撤回不再 reload：session id 不变、无 loading 态、
子代理不被 cancel、回执延迟从基线中位数 1600ms 降到 **14–30ms**。

| 项 | 结果 |
|---|---|
| 有补丁 | **9/9 全绿**（R0 被撤消息消失、R1 session id 不变、R2 无 loading、R5 模型看不到被撤内容） |
| 无补丁（变异） | **8/9，R0 红**（被撤消息仍在时间线） |
| 两次都 | `reload 记录: 无` —— 证明消失只能归因 A2 截断，不是 reload 的功劳 |

## 补丁

**目标**（daemon 唯一实际加载路径）：
```
~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
```

| 项 | 值 |
|---|---|
| 官方原版 md5 | `408f99fcaa8cf8a760a3646d788be774` |
| 打补丁后 md5 | `431a6e87d3477cdd824f9c3041c22eaf` |
| 改动 | +31 行：`revert()` 末尾调 `truncateHistoryFrom(messageId)`；`publish()` 前加截断方法 |
| 脚本 | `~/.paseo/local-patches/apply-rewind-history-truncation.mjs`（幂等、md5 守卫、`--revert` 回滚） |
| 重打 | `~/.config/systemd/user/paseo.service` 的 `ExecStartPre`（实测已执行 `status=0`） |

`agent-manager.js` 已回滚到官方原版 `45fceeb6a9a1a2eda89fbf6c83a08779`（旧 22 行
`deleteParent` 补丁已被双向证伪且从未生效，已删除）。

## 插件侧删除（P2）

`paseo-plugin/server/provider.ts`：1963 → 1637 行（**-353 / +27，净减 326 行**）

| 删除项 | 内容 |
|---|---|
| `#refreshAgent` | spawn `paseo agent reload` 整个函数 + 50ms 定时器 + 15s 安全网 |
| `#resolvePaseoBinary` | `PASEO_BIN` / `which paseo` 解析 |
| `findPaseoAgentId` + `claimedSessionIds` | 扫描 `~/.paseo/agents/` 反查 agent id（104 行） |
| `#reverting` 门禁 | 声明 + prompt 拒绝 + 二次撤回守卫 + `#releaseRevertingFor` + 全部 clear/delete |
| `#agentIds` | 声明 + 全部读写（`agentId` 读取保留，用于子代理作用域） |
| 「正在回退，请稍候」 | 提示通知（回执已即时，无需等待提示） |
| 四个 import | `readdirSync`/`readFileSync`/`homedir`/`execFileSync` |
| 文件回退失败通知 | 从 `#deferNotice`（等重开）改为 `#notice` 即时发出 |

**未删**（有意保留）：`parked-sessions.ts` 的 `quiesce`/`hold`/`release`（服务共享进程退役，
被「一进程多会话」复用）、`#notice`（open warning 与文件回退失败通知都要发）、文件回退层、
派发锚/中断、`folded` Map（子代理重放通用优化）。

> **补记（2026-10-26 07:4x，本轮清理）**：上表原本把 `#deferNotice`/`#flushDeferredNotices`
> 和 `#dshIds` 也列为「有意保留，理由是服务 open warning」。该理由**不成立**：`#notice` 的三个
> 调用点（revert 文件失败、两处 open warning）全部发生在 session 已注册之后，于是永远走
> `#sessions.has` 的 emit 分支、永不进 defer —— `#deferredNotices` 恒空、
> `#flushDeferredNotices` 恒早退，`#dshIds` 只被这条死链读取。三者已在本轮连同
> `MAX_DEFERRED_NOTICES`/`MAX_DSH_ID_MAPPINGS` 一并删除；`DeferredNotice` 改名为 `OpenWarning`
> 保留（`openWarnings` 生产在用）。

## 断言同步更新

| 文件 | 变更 |
|---|---|
| `harness/revert-check.mjs` | 11 条失效断言改写为断言「reload 已删除」；**112 passed, 0 failed** |
| `harness/session-request-check.cjs` | 「working notice」「refresh 警告」改为断言其**不存在**；**11/11 passed** |
| `harness/rewind-native-check.mjs` | 新建真机探针（走 daemon 协议 `rewindAgent`，非桥） |

## 真机验收（2026-10-26 05:30）

```
[4] 撤回第二条 → 回执 18ms，reload 记录: 无
[5] R0 被撤 messageId 已不在时间线 ✓ / 撤回点之前的消息仍保留 ✓
[6] R1 sessionId 8eeefd06 → 8eeefd06 一致 ✓
[7] R2 状态序列 running, idle（无 loading/initializing）✓
[8] R5 撤回后继续对话，回答 ALPHA（看不到被撤的 BETA）✓
9 通过, 0 失败
```

## 延迟对照

| | 基线（旧，4 次样本） | 现在（多次实测） |
|---|---|---|
| 回执延迟 | 6875 / 506 / 1565 / 1800 ms | **14 / 17 / 18 / 19 / 22 / 30 ms** |

## 关键教训（写进流程）

1. **判据必须先排除旁路**：reload 未删时，任何「事后查时间线」的判据都会被 reload 掩盖。
   `fetch_agent_timeline` p50 914ms，而 reload 在 679ms 后发生，采样必然落在 reload 之后。
2. **判 reload 用 daemon 日志**（`Refreshing agent`），不要用时间线。
3. **补丁生效必须比「文件 mtime vs 真 daemon 进程启动时刻」**：曾出现补丁 04:07 写入、
   daemon 04:04 启动，导致在无补丁 daemon 上「验证」了一轮。
4. **`item.messageId` 有两种形态**：请求传裸 uuid，时间线里是 `user:<uuid>`；匹配要用
   `clientMessageId` 兜底。

## 未验证项

- `ExecStartPre` 在升级（`npm i -g @getpaseo/cli`）后重打的实机验证：锚点若变会 fail closed，
  届时 daemon 起不来，应急为注释该行。
- 多子代理并发撤回、子代理编辑归并撤回未在 A2 下重测（文件层本次未动，行为应不变）。

---

## 死代码清理（2026-10-26 05:40）

用户批准后清理三处零调用代码。

### 1. `paseo-plugin/server/parked-sessions.ts`：512 → 216 行（**-296**）

| 删除 | 行数 | 依据 |
|---|---|---|
| `park()` | 56 | 生产代码零调用；且它是 `#pool` 的**唯一写入点** |
| `take()` | 32 | 零调用 |
| `discard()` | 36 | 零调用 |
| `sweep()` | 29 | 零调用（`start()` 的定时器只调它） |
| `has()` | 10 | 零调用 |
| `forget()` | 7 | 零调用 |
| `#markDying()` | 14 | 只被上面几个死方法调用 |
| `#evictOverflow()` | 31 | 只被 `park()` 调用 |
| `#pool` / `size` / `busy` / `#max` / `#ttlMs` / `#timer` | ~20 | `#pool` 唯一写入点已删，恒空 |
| `POOL_KEY` / `ParkedEntry` / `DEFAULT_TTL_MS` / `DEFAULT_MAX` / `SWEEP_INTERVAL_MS` / `parkedSessionHandlers` | ~11 | 随之无引用 |

**保留（真在用）**：`hold()` / `release()`（`provider.ts:617/638/693`）、
`quiesce()`（`provider.ts:1157`，服务共享进程退役后等 session log 写锁）、
`start()` / `stop()`（已简化为 no-op + 计数归零）。

### 2. `harness/parked-sessions-check.cjs`：476 行，**整个删除**

它 100% 测的是上面已删的死方法（`pool.park/take/sweep/size/has`），留着必然全红。

### 3. 另两处小死代码

| 项 | 位置 | 行数 | 依据 |
|---|---|---|---|
| `LEGACY_INTERNAL_COMMANDS` | `timeline.ts:30` + 使用处 | ~12 | 扫描本机 **928 个会话日志，`rewind`/`undo`/`permission` 命令行零命中** |
| `routeKeyOf` | `session.ts:285` | 8 | 零调用点（注释自称「Currently has no callers」） |

### 断言同步

`harness/revert-check.mjs` 的 `'internal command rows are filtered only as legacy cleanup'`
翻转为断言该常量**不存在**（并在注释里写明翻转理由与 928 个日志的取证）。

### 清理后验收

```
revert-check.mjs          112 passed, 0 failed
surface-check / file-snapshot / rewind-merge / revert-shape / bridge-assets  全部 PASS
9 个 UI harness（timeline/newest/tool-call/thinking/locale/style/sweep/
  agent-message/uploaded-file）                                              全部 PASS
session-request-check.cjs 11/11
tsc --noEmit              0 错误
真机 rewind-native-check   9/9（回执 31ms，reload 记录：无）
```

### 累计代码量

| 阶段 | 变化 |
|---|---|
| P2 删 reload 旁路 | `provider.ts` 1963 → 1637（**-326**） |
| 死代码清理 | `parked-sessions.ts` 512 → 216（**-296**）、`parked-sessions-check.cjs` **-476**、`timeline.ts` -12、`session.ts` -8 |
| **合计净减** | **约 1068 行** |

---

## 第二轮清理（2026-10-26 07:00–08:00）

用户要求「多成员同步审查关于撤回的所有提交、拆分成员细化任务、清理历史提交里无用代码并跑回归」。
本轮按代码层分三条只读 lane 并行审查（桥层 / 插件层 / 基线），Lead 判定后分两条写 lane 实现。

### 删前基线（HEAD `4dfa03a`，37 个可跑脚本）

`2047` 断言、`0` failed、`tsc --noEmit` 0 错误。连跑两次数字一致，非 flaky。

### 桥层（提交 `5dc0ca9`）

桥**不是** reload 时代的死代码重灾区：6 模块 21 个导出里 17 个生产可达（`server.js`
直接 import 调用），撤回原生化后桥仍是实现主体。真零调用只有 3 项 14 行：

| 项 | 依据 |
|---|---|
| `file-snapshots.js` 的 export 语句 | 四个常量全仓无外部 import，文件内仍活（只删 export） |
| `child-anchors.js` `get size()` | 全仓 0 命中 |
| `child-anchors.js` `rootFor()` | 全仓仅定义行。**无连带**：`rootSessionId` 字段仍被 `withdrawnSince`/`delete` 读 |

另修 4 处「rewind reload」过期注释（`server.js` 仅注释，剥离注释后与改前逐字相同）。

### 插件层（提交 `cc8f7c4`）

| 项 | 变化 |
|---|---|
| `provider.ts` 延迟通知链 | **-114 行** |
| `parked-sessions.ts` 死状态 | 216 → 135（**-81**） |
| `session.ts` / `dsh-process.ts` | 仅注释（剥离后与改前逐字相同） |
| 文档 | AGENTS.md 3 处、REWIND.md 整节重写、PROGRESS 数字修正、FIELD-NOTES 加标注 |

**`#deferNotice` 保留理由被推翻**：上一轮记录「有意保留（服务 open warning）」，实测
`#notice` 三个调用点（revert 文件失败 + 两处 open warning）全在 session 已注册后——
revert 路径上 `#require` 可能返回 `DshChildSession`，但 `DshChildSession.revert` 直接抛
「子会话不支持撤回」，所以走到该分支的必是 root session、必在 `#sessions` 里 → 必走
emit 分支。defer 分支永不进入，`#deferredNotices` 恒空。

### 失效断言（变异实测取证，不是静态推断）

| 断言 | 原写法为什么是假绿 |
|---|---|
| `revert-check:207` `createSystemMessage` | 符号 7eeba97 已移除；加回两种写法后**仍绿** |
| `revert-check:493` `timer.unref()` | 实际写法是 `timer.unref?.()`，`?.` 让正则永不匹配 |
| `revert-check:334` 「answers the rewind」 | 删掉 revert 分支回执后**仍绿**（匹配到 interrupt 分支的回执） |
| `revert-check:371` 「no token-less live row」 | `[].every()` 在 calls 为 0 时恒真 |
| `revert-check:451` 「old assistant/message placeholder」 | 120 字符窗口，间隔 481 字符即漏报 |

全部改写/删除，并逐条做「同一变异下旧断言仍绿、新断言变红」的双向验证。

**一条被实测推翻的论断**：`quiesce` 的 `async` 并非 concurrent-open 复现竞态的**唯一**
微任务让出点——改成同步、或删掉 `await` 后该 harness 仍 8/8（`await replaced.close()` 与
`await session.open()` 也足以复现窗口）。仍保留 async 与签名（零成本），javadoc 写实测结论。

### 删后回归（同套 37 脚本，逐条比对）

```
36/37 完全一致，唯一变化 revert-check 112 → 111（删除恒绿断言所致）
断言总数 2047 → 2046      0 failed      tsc --noEmit 0 错误
```

### 真机验收（重启后）

自唤醒链路（`--on-active=10s`，transient unit 落独立 cgroup）：

```
cgroup(self)=.../app.slice/selfwake-rewind-cleanup-*.service
daemon     =.../app.slice/paseo.service          ← 不同 cgroup，重启杀不到
READY 用时 1.3s → send 成功
```

新鲜度三点比对：daemon 新实例 `07:56:02` **晚于**源码 mtime `07:52:12`；live 桥
`07:56:07` 被重写且与仓库**逐字节一致**；`rootFor` 已从 live 桥消失；补丁 md5 不变
（`already patched` 幂等跳过）。

| 检查 | 结果 |
|---|---|
| `harness/rewind-native-check.mjs` | **9/9**（回执 27ms、session id 不变、无 loading、模型看不到被撤内容） |
| `harness/plugin-check.cjs` | **32/32**（事件形状无回归——这是上一轮的最大验证缺口） |

### 累计代码量

| 阶段 | 变化 |
|---|---|
| P2 删 reload 旁路 | `provider.ts` 1963 → 1637（-326） |
| 第一轮死代码清理 | `parked-sessions.ts` 512 → 216（-296）、`parked-sessions-check.cjs` -476、`timeline.ts` -12、`session.ts` -8 |
| 第二轮桥层 | -14 行死码 + 4 处注释 |
| 第二轮插件层 | `provider.ts` 1637 → 1523（**-114**）、`parked-sessions.ts` 216 → 135（**-81**） |
| **合计净减** | **约 1345 行** |

---

## 回归中发现的既有 flaky（提交 `f758ba1`）

最终验收时 `file-snapshot-check` 出现 `52 passed, 2 failed`，查清后是**既有真 bug，非本轮引入**。

### 根因

`file-snapshots.js` 的 `#rescue()` 用 `${Date.now()}-${counter}-${digest}-${readable}` 命名，
而 `counter` 是 `restore()` 内的局部计数器（每次调用重置为 1）。两次撤回落在**同一毫秒**
时文件名完全相同，第二次 `copyFile` 静默覆盖第一次的 rescue 副本。

rescue 是用户手动恢复材料，被覆盖 = **撤回前的原始内容永久丢失**。
代码注释本就声称「two rewinds restoring the same path must not overwrite the earlier
rescue copy」，但实现没做到——注释不是行为证据。

### 为什么基线没抓到

基线固定时恰好全绿。实测复现率约 **9.3%**（改动前 `4dfa03a` 纯净副本 150 次连跑红 14 次），
单次跑绿不能证明没有 flaky。

### 修法

局部计数器 → 模块级 `let rescueSeq = 0`，文件名 `${Date.now()}-${++rescueSeq}-${digest}-${readable}`。
时间戳仍在首位所以可读。不用 `COPYFILE_EXCL`：那会给 rescue 增加一条抛错路径，
而 rescue 的职责恰恰是不丢数据。

### 验证

| 项 | 结果 |
|---|---|
| 改动前纯净副本 150 次 | **红 14 次（9.3%）** |
| 改动后 30 次 | **30/30 全绿** |
| 变异：旧实现 + 新确定性断言 | **6/6 必红** |
| 变异：修复版注入回旧缺陷 | **5/5 必红**，还原后 5/5 绿 |

断言同步：原「and both contain real pre-restore content」只重复了上一条的
`rescues.length === 2`、从未读内容（恒绿）→ 改为真读文件内容；新增「同毫秒内
rescue 必须唯一」（钉住 `Date.now` 为定值）。

### 同类问题扫描

全仓其余 `Date.now()` 拼接均非「持久文件名 + 同毫秒可重入」：notice id 带随机数、
`turnId` 会话内串行、图片路径已用模块级序号。**无第二处**。

### 最终全量回归

```
37/37 脚本全绿，0 failed，tsc --noEmit 0 错误
断言总数 2047 → 2048
  file-snapshot  54 → 56（新增 2 条确定性断言）
  revert-check  112 → 111（删 1 条恒绿断言）
```

### 第二次重启后真机验收

自唤醒再次生效（`--on-active=10s` → `READY 1.3s` → `send 成功`，cgroup 仍独立）。
daemon 新实例 `08:12:43` 晚于源码 mtime `08:05:00`；live 桥与仓库**逐字节一致**。

`harness/rewind-native-check.mjs` → **9/9**（回执 34ms、session id 不变、无 loading、
模型看不到被撤内容）。
