# 撤回（Rewind）

Paseo 在每条用户消息下方提供一个撤回按钮；点开是「此操作无法撤销」+「回退对话和文件」。
OpenCode / Codex provider 有这个按钮，DSH provider 原本没有——本文记录它现在是怎么接的、
为什么这么接、以及哪些前提不能破。

## 契约（来自 Paseo，不是我们编的）

| 事实 | 位置 |
|---|---|
| 撤回是 provider 能力位 | `@getpaseo/plugin/dist/server/provider.d.ts` 的 `PROVIDER_CAPABILITIES`：`session.revert.both` / `.conversation` / `.files` |
| 请求形状 | 同文件：`{ type:"session.revert", requestId, sessionId, token, scope }` |
| 令牌来源 | 时间线项的 `revertToken`（`ProviderTimelineIdentity`）；Paseo 按行缓存，点击时原样回传 |
| 按钮显示条件 | `plugin-provider.js`：`supportsRewindBoth/Conversation/Files` 由能力位算出 |

所以"加一个按钮"需要三处同时成立：**声明能力位**、**行上带令牌**、**处理请求**。

## 实现

```
Paseo 撤回按钮
  → provider.ts   capabilities + case "session.revert"
  → DshSession.revert(token, scope) → DshProcess.revert
  → 桥 paseo/revert { sessionId, token, scope }
  → dsh-bridge/lib/revert.js：令牌 → /rewind <n> 命令
  → ctx.commands.execute(agent, "/rewind <n> [--conversation|--code]")
  → dsh-rewind：表面替换（对话）+ git 快照恢复（文件）
```

**为什么复用 `dsh-rewind`**：它已经实现了 DSH 的对话回退语义（用与 compaction 相同的
surface replacement 事件把作废消息从模型可见面移除，且模型上下文里不会出现任何回退痕迹）
以及文件回退的 git 快照账本。撤回是"改历史"的高风险操作，自己重写边界（未跟踪文件、rename、
非 git 工作区）收益远小于风险。

**依赖**：`dsh-rewind-plugin@0.15.3`，装在 `~/.dsh/profiles/paseo`。它的客户端部分是
`platform: "web"`，在 paseo profile 里只用到它的**服务端命令**。

装的时候要注意两点：

- **版本门禁豁免**：它对 `@deepseek-ai/dsh-*` 的 peer 要求是 `^0.2.1-rc.1`，本机 DSH 是
  `0.2.0-rc.2`，需要用 `dsh plugin allow-version` 显式豁免才能装上。装上后实测可用。
- **不要装 0.11.x**：那一版读 `session.events[seq]`，而本机 DSH 已移除该属性（改用
  `session.eventAt(seq)`），命令一执行就抛 `Cannot read properties of undefined`。

## 两条不能破的规则

1. **锚点判定必须逐字复刻 `dsh-rewind`**。我们算出序号 `n` 再交给它的 `/rewind <n>`，两边
   的"可回退消息清单"只要差一条，就会回退到**错误的消息**——而且不会报错。因此
   `dsh-bridge/lib/revert.js` 的 `isRewindAnchor` 与它的 `isRewindAnchorEvent` 完全一致：
   `source.kind === 'user'` 的消息，**没有别的**（0.11.x 还额外算自己的 plugin 锚点、并排除
   标记行，0.15.x 不需要）。**升级插件后必须重新核对这条规则**，`harness/revert-check.mjs`
   里有一整组断言。
2. **目标必须用 `@<seq>`，不能用序号**。0.15.x 的 `/rewind` 接受 `<index>` 或 `@<seq>`，
   传 seq 让插件自己在可见面上解析，两边就不可能对"第几条"产生分歧。我们自己的锚点判定
   只用于**提前拒绝**已不可回退的行（给出可读错误），不用于编号。

**能力位的取舍**：0.15.x 只有 `chat` 和 `both` 两种模式，**没有"只回退文件"**。所以
`provider.ts` 只声明 `session.revert.both` 和 `session.revert.conversation`，不声明
`session.revert.files`——声明一个后端做不到的能力，比菜单里少一项更糟。

## 行为约定

- **工作区有未提交改动 → 完全拒绝**，不做"只回对话"的半回退。错误信息会列出改动并要求
  先提交或 stash。理由：让对话跑到文件前面，正是这个功能要消除的不一致。
- **非 git 工作区 → 拒绝文件回退**，提示改用「只回退对话」。
- **子会话不支持撤回**（只读投影，没有自己的进程）。
- **不做 `/unrewind`**：Paseo 的菜单本身就是「此操作无法撤销」。

## 回滚

- 代码：`git revert <commit>`
- profile 依赖：`dsh plugin --profile paseo remove dsh-rewind`，然后重启（`paseo plugin reload dsh-paseo`）
- profile 备份：`~/paseo-profile-backup-rewind-*.tgz`

## 验证

`harness/revert-check.mjs` 离线断言两层：

- **纯函数**：锚点判定（含标记行、空 plugin 气泡、信封）、令牌校验、序号计算（含"压缩后
  只剩一条可见"的场景）、scope → 命令参数、脏工作区文案。
- **接线（读源码）**：provider 声明三项能力位并分发 `session.revert`；实时行与重放行都带
  `revertToken`；插件确实请求 `paseo/revert`；桥确实拒绝脏工作区与非 git 目录。

`harness/steer-check.cjs` 另断言：同一用户消息行二次下发（先显示、后补令牌）共享同一个
行 id，且末次带令牌——Paseo 的 timeline 按 id upsert，所以这是一行更新而不是两行。
