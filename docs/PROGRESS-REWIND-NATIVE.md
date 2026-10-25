# 撤回原生化（A2）实施进度

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

**未删**（有意保留）：`parked-sessions.ts` 全部（`quiesce`/`hold`/`release` 服务共享进程退役，
被「一进程多会话」复用）、`#notice`/`#deferNotice`/`#flushDeferredNotices`（服务 open warning）、
`#dshIds`、文件回退层、派发锚/中断、`folded` Map（子代理重放通用优化）。

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

### 1. `paseo-plugin/server/parked-sessions.ts`：512 → 266 行（**-246**）

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
| 死代码清理 | `parked-sessions.ts` 512 → 266（**-246**）、`parked-sessions-check.cjs` **-476**、`timeline.ts` -12、`session.ts` -8 |
| **合计净减** | **约 1068 行** |
