# paseo 升级后怎么办

面向「以后 `npm i -g @getpaseo/cli` 之后要做什么」的操作手册。

**一句话结论：正常情况下什么都不用做。** 升级后第一次启动 daemon 时，`ExecStartPre` 会自动把
**turnId 补丁**重新打上（锚点自适配，不管上游改了什么无关字节、换了缩进还是换了行尾）。只有
锚点真的失配时才需要人工介入，而且那时 daemon 仍然能起来，只是「重开会话后长对话折叠轮次」
不可用（不丢数据）。

**从 0.15.0 起，rewind（撤回后时间线刷新）补丁已退休**：上游 PR #8368 原生修好 #4667，
0.15 的 `PluginSessionHistory` 也没有旧补丁依赖的数组语义。所以 `local-patches/` 现在只剩
`turnId` 一个 target，`plugin-provider.js` 不再被触碰。

---

## 0. 先理解这三样东西

| 文件 | 作用 |
|---|---|
| `~/.paseo/local-patches/apply-rewind-history-truncation.mjs` | 给 `agent-manager.js` 打 turnId 补丁（两条历史重放路径把 `event.turnId` 传给 `recordTimeline`）。幂等，可反复跑。文件名是历史名 |
| `~/.config/systemd/user/paseo.service.d/10-rewind-patch-soft-fail.conf` | 让上面那个脚本作为 `ExecStartPre` 运行，且**失败不阻止 daemon 启动**（`-` 前缀） |
| `~/.paseo/local-patches/check-rewind-patch.mjs` | 只读体检：补丁现在到底有没有生效 |

补丁改的是**全局安装的 paseo**，不是仓库：

```
~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/
  dist/server/server/agent/agent-manager.js
```

`npm i -g @getpaseo/cli` 会整树替换这个目录 → **补丁消失**，这是唯一需要在意的点。
`paseo.service` 本体也可能被重写，所以软失败配置放在 `paseo.service.d/` drop-in 里。

---

## 1. 升级前：先布自唤醒

升级要重启 daemon，而**当前会话就跑在 daemon 的 cgroup 里**，重启会把会话一起杀掉。
所以重启前必须先排一个落在**独立 cgroup** 的唤醒（`setsid`/`nohup` 不够，逃不出
`KillMode=control-group`）：

```bash
node ~/.paseo/local-patches/restart-with-wake.mjs \
  --agent <当前 agent id> --delay 10 --tag upgrade
```

它做三件事，顺序不可颠倒：
1. `selfwake.mjs --snapshot` 记录当前 daemon 实例为基线（这样能判「实例真的换了」而不只是「端口开了」）
2. `systemd-run --user --on-active=10s` 排定唤醒 unit（独立 cgroup）
3. `systemctl --user restart paseo.service`

**已验证**：`--on-active=10s` → `READY 1.3s`（daemon 就绪后 1.3 秒唤醒成功），跑过两次
（tag `rewind-cleanup`、`rescue-fix`，见 `restart-with-wake.log` / `selfwake.state.json`）。

如果升级由别的途径触发（比如 `paseo` 自己的更新检查），那也一样：**任何重启 daemon 的动作前先布唤醒**。

---

## 2. 升级：装新版本

```bash
npm i -g @getpaseo/cli
```

装完**先别急着重启**，跑一次体检：

```bash
env -u NODE_OPTIONS node ~/.paseo/local-patches/check-rewind-patch.mjs
```

### exit code 表

**先说清楚：`check-rewind-patch.mjs` 与 `apply-rewind-history-truncation.mjs` 各有一套 exit code，
数字含义不同，别混用。** 0.15 起 rewind target 已退休，旧的 `check 4`（上游已自修、该退休）与
`apply 3`（DEGRADED）**不存在了**。

`check-rewind-patch.mjs`（只读体检）：

| exit | 含义 | 该做什么 |
|---|---|---|
| `0` | 补丁在位且实现体是最新的 | 无需动作，直接重启 |
| `1` | 需要跑一次 apply。两种情形：① 补丁不在位但两处重放调用都命中（`state: patchable`）；② 标记齐全但**实现体是旧版**且**可原地重建**（`state: stale-body`）。**要区分请看 `state`，不要只看 exit code** | 也无需动作：下次启动 daemon 时 `ExecStartPre` 会自动打上。想立刻确认就手动跑一次 `node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs` |
| `2` | **需人工**，apply 会拒绝且不写文件。四类：① 半打补丁（marker 既不是 0 也不是 2）；② `state: anchor-mismatch`（两处重放调用没有恰好命中 2 次）；③ `state: anchor-context-mismatch`（命中顺序/后续代码不对）；④ `state: stale-body-unrebuildable`（旧体无法原地重建） | 见第 3 节。都**不要**反复跑 apply——它会 fail closed。先重装 `@getpaseo/cli` 拿回干净文件；若是上游改了重放调用，按新形状改锚点 |
| `3` | 目标文件不存在 | paseo 可能没装好，或安装路径变了。先 `which paseo` / 确认 `@getpaseo/server` 是否在预期位置 |

`apply-rewind-history-truncation.mjs`（会写文件，`ExecStartPre` 与启动钩子跑的就是它）：

| exit | 含义 | 该做什么 |
|---|---|---|
| `0` | turnId 补丁到位（新打 / 已在位 / 旧体已原地重建），或 `--revert` 成功/幂等跳过 | 无需动作 |
| `1` | 失败（目标缺失、锚点失配、半打、写失败、语法校验失败等），**不会留下半写文件** | 看 stderr 与 `rewind-patch.status.json` 里的 `reason`，按第 3 节处理 |

`apply --check` 的 exit code 与上表第一张（checker）相同（`0/1/2/3`），它不写任何文件。

> `--json` 的机器字段：`code`/`state`/`ok`/`autoPatchable`/`patchBody`/`staleDetail`/
> `turnIdMatches`/`turnIdContext`/`rebuildBlockedReason`/`rebuildBlockedDetail`/`lastRun`。
> `rebuildBlockedReason` 与 apply 实际写进 `rewind-patch.status.json` 的 reason 是**同一个值**
> （两处共用 `turnIdRebuildPlan`），不是猜的。

`--json` 给机器读：

```bash
node ~/.paseo/local-patches/check-rewind-patch.mjs --json
```

它会顺带打印 `rewind-patch.status.json`，即**上次 `ExecStartPre` 是成功还是失败**。
注意状态文件只是缓存：它可能是上一次启动留下的，而目标文件已经被 `npm i -g` 换掉了，
所以判定一律以真实文件内容为准。

然后重启：

```bash
systemctl --user restart paseo.service
```

重启后再确认一次（此时状态文件应该已更新）：

```bash
node ~/.paseo/local-patches/check-rewind-patch.mjs
systemctl --user show paseo.service -p ExecStartPre    # 应看到 ignore_errors=yes
journalctl --user -u paseo.service -b --no-pager | grep rewind-patch | tail
```

---

## 3. exit 2：锚点真的失配了，怎么修

补丁靠一个**结构锚点**定位两处重放调用（不是靠 md5）。这个调用必须**恰好命中 2 次**：

- 干净文件里长这样（0.14.0 与 0.15.0 逐字相同）：
  ```js
  const row = this.recordTimeline(agent.id, event.item, event.timestamp ? { timestamp: event.timestamp } : undefined);
  ```
- 两处命中之后必须分别跟着 `if (broadcastTimeline) {`（`forceHydrate…`）和
  `if (deferredBroadcast) {`（`primeTimeline…`），**顺序固定**——用来证明命中的是两条不同的
  重放路径，而不是同一处的两份拷贝。

调用是**空白弹性正则**（`[ \t]*` + `\r?\n` 容错），所以上游改缩进（4→2 空格）、换 Tab、
换 CRLF 都能自动适配。失配只有三种真原因：**调用被改写/删除**、**出现歧义（>1 次）**、
**上下文行变了**。

### 诊断

```bash
# 看 check 报出的实际状态与命中数
node ~/.paseo/local-patches/check-rewind-patch.mjs

# 直接看上游现在长什么样
T=~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js
grep -n 'this.recordTimeline(agent.id, event.item' "$T"
grep -n 'LOCAL PATCH (paseo-dsh): keep the turn id on replay' "$T"   # 应为 0（干净）或 2（已打）
```

### 修法

1. 把 `~/.paseo/local-patches/apply-rewind-history-truncation.mjs` 里的 `TURNID_CALL_RE` /
   `TURNID_CONTEXTS` 按新形状改。要求不变：**调用整行写全**（否则会误命中别的
   `recordTimeline`），**保留缩进捕获组**（插入时要复用它），**两处上下文按顺序断言**。
2. 用临时副本验证，别直接打真文件（**注意：只有 `REWIND_PATCH_TURNID_TARGET` 一个目标变量**，
   旧文档里的 `REWIND_PATCH_TARGET` 已随 rewind target 删除）：

   ```bash
   T=~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js
   cp "$T" /tmp/am.js
   REWIND_PATCH_HOME=/tmp/patch-test \
   REWIND_PATCH_TURNID_TARGET=/tmp/am.js \
     env -u NODE_OPTIONS node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
   # 期望 exit 0 + ESM syntax ok，且真机的 agent-manager.js md5 不变
   ```
3. 验证通过再打真的：
   ```bash
   env -u NODE_OPTIONS node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
   ```
4. 如果上游**已经自己修好了**（重放调用开始传 `turnId`），那就别修锚点了，直接删补丁
   （见第 5 节）。

> 上游改一个无关字节**不该**被当成故障——判定靠锚点，不靠 md5。

---

## 4. 降级了是什么表现

turnId 补丁没生效时（exit 1/2，或 `ExecStartPre` 失败）：

- **不丢数据**，撤回、文件恢复、模型上下文全部正常；
- 唯一的影响：**重开会话后长对话的回合不折叠**（每一步单独成块，而不是按回合分组）；
- 修好补丁后重开会话即可恢复，无需迁移任何数据。

**rewind 不再是降级项**：Paseo 0.15.0+ 原生刷新时间线，不需要本地补丁。只有回滚到 0.14.0
才会退化为「撤回后时间线不刷新」（见第 7 节）。

---

## 5. 什么时候可以彻底删掉 turnId 补丁

上游把两处历史重放路径改成把已有的 `turnId` 传给 `recordTimeline` 之后（即
`const row = this.recordTimeline(agent.id, event.item, { … turnId: event.turnId … })` 这类写法），
这个补丁就多余了。判断方式：

```bash
node ~/.paseo/local-patches/check-rewind-patch.mjs; echo "exit=$?"
```

看到 `state: anchor-mismatch`（exit 2）且 grep 确认重放调用已经带 `turnId`，就说明上游自己修了
——按下面顺序删（先验证再删，别反过来）：

```bash
# 1. 真机验证：新会话聊几轮 → 重开会话 → 长对话仍按回合折叠（不再需要补丁）

# 2. 删 drop-in 与 unit 本体里的 ExecStartPre（若先删了 drop-in，本体那条就成了硬失败，别漏）
rm ~/.config/systemd/user/paseo.service.d/10-rewind-patch-soft-fail.conf
# 同时删掉 20-startup-patch-hook.conf 里的 NODE_OPTIONS 行（或整个 drop-in）
systemctl --user daemon-reload

# 3. 删脚本
rm ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
rm ~/.paseo/local-patches/check-rewind-patch.mjs
rm ~/.paseo/local-patches/startup-patch-hook.cjs
```

`agent-manager.js.orig-turnid-*` 备份建议留一份再删（回滚材料）。

---

## 6. 回滚 turnId 补丁（想临时恢复官方行为）

```bash
env -u NODE_OPTIONS node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs --revert
```

行为：
- 从**最近一次成功打补丁时记录的备份**还原（`agent-manager.js.orig-turnid-*`，写在
  `~/.paseo/local-patches/`（`REWIND_PATCH_HOME`）里，**不在** npm 全局包目录——早先备份写在
  `dist` 里，`npm i -g` 会把它连树删掉，恰好是升级后需要回滚的那一刻）；
- **原子写**：先写同目录临时文件再 `renameSync` 覆盖。还原失败时目标文件要么是完整的旧
  （已打补丁）内容、要么是完整的干净内容，**不会**出现半截文件；
- 还原后校验 **MARKER 计数 == 0**（确实是干净未打补丁状态）+ **ESM 语法检查通过**；
- 任何一步失败都会把**回滚前的已打补丁内容放回去**；连这个都写不进去时，`status.json` 会记
  `rollbackSucceeded: false` 并明说「目标文件可能已是备份内容、期望 md5 是 X」，不会假装成功。

**幂等**：如果目标文件本来就没有补丁标记（比如刚升级完、还没打过），`--revert` 会直接
跳过（`reason: turnid-revert-noop`），**不会**用旧备份覆盖新上游文件。

> `--revert` 只回滚 turnId 一个 target。它**不会**清 `plugin-provider.js` 上旧版留下的
> rewind 补丁（新脚本不认识那个 marker）：升到 0.15 时整树替换会自然清掉；留在 0.14 上想清，
> 用旧版脚本 `--revert` 或重装 CLI。
>
> 注意 `--revert` 只是撤销补丁，**不会**改 drop-in。所以下次启动 daemon 时 `ExecStartPre`
> 又会把补丁打上。要真正保持官方行为，得同时把 drop-in 里的那行注释掉。

---

## 7. 回滚 Paseo 0.15.0 → 0.14.0

```bash
# 1) 重启前先布自唤醒（同第 1 节）
node ~/.paseo/local-patches/restart-with-wake.mjs --agent <agent id> --delay 10 --tag rollback-014

# 2) 装回 0.14.0（精确版本；会把 server 0.14.0 一起装回）
npm i -g @getpaseo/cli@0.14.0

# 3) 重启（ExecStartPre/钩子会按 0.14 的 agent-manager.js 重打 turnId；turnId 锚点在 0.14 上同样命中）
systemctl --user restart paseo.service
env -u NODE_OPTIONS node ~/.paseo/local-patches/check-rewind-patch.mjs   # 期望 exit 0（turnId 在位）
```

**回滚后的行为退化（可接受，明确记录）：**

- **撤回本身照常工作**（对话、文件、模型上下文都回退），但**时间线不再自动刷新**：被撤的
  消息行会留在屏幕上，直到执行 Reload agent 或重开会话。
- 此时插件发的 canary「撤回已生效」会随宿主重放出现在重建后的时间线里，告诉用户怎么刷新
  ——这正是它存在的意义；在 0.15 上 replay 会把它清掉（预期，见 `docs/REWIND.md`）。
- **不再往 0.14 上重打 rewind 截断补丁**：0.14 的 `plugin-provider.js` 结构（数组 history）
  虽然还认旧补丁，但旧补丁已从仓库删除、不再维护；需要时用历史版本的脚本（git 历史里
  `local-patches/apply-rewind-history-truncation.mjs` 的 0.15 之前版本）临时打，并自行承担
  维护成本。日常回滚建议接受上面的降级。
- `~/.dsh/paseo-rewind/`（文件 journal/objects/rescue）不需要清；0.14 的撤回文件层与 0.15 相同。

**数据兼容风险【未验证】**：0.15 运行期间写入的 `~/.paseo`（agents/config/时间线）与
`~/.dsh` 会话在 0.14 下是否可读，未实测。回滚前建议备份 `~/.paseo/config.json`、
`~/.paseo/agents`、`~/.dsh/sessions`。0.15 原生 rewind 写入的 DSH 撤回缝仍是
`user/message` 表面替换（格式未变），0.14 的桥按 `source.kind === "paseo-rewind"` 折叠，
理论上可读。

---

## 附：状态文件

`~/.paseo/local-patches/rewind-patch.status.json`，每次运行 `apply` 都写（成功也写，
这样「上次成功」和「从没成功」可区分）。**任何**失败都会留下状态文件，包括未预期异常
（`reason: unhandled`）—— 不会出现「崩栈了但状态文件还停在上一次 ok:true」的假绿。

```json
{
  "ok": true,
  "at": "2026-11-03T06:05:52.086Z",
  "reason": "turnid-patched | turnid-already-patched | turnid-patched-from-stale | turnid-reverted | turnid-revert-noop | turnid-anchor-mismatch | turnid-anchor-context-mismatch | turnid-partially-patched | turnid-target-missing | turnid-stale-anchor-mismatch | turnid-write-failed | turnid-syntax-check-failed | turnid-syntax-check-unavailable | unhandled",
  "target": "<被改的文件>",
  "targetMd5": "<改完之后的 md5>",
  "paseoVersion": "<@getpaseo/cli 版本，读不到为 null>",
  "message": "<给人看的一句话>",
  "upstreamMd5": "<打补丁前上游的 md5>",
  "patchedMd5": "<打补丁后的 md5>",
  "backup": "<这次用的备份路径>",
  "turnIdMarkers": 2,
  "patchBody": "current | stale | rebuilt-from-stale"
}
```

`reason` 分类：

| reason | ok | 含义 |
|---|---|---|
| `turnid-patched` / `turnid-patched-from-stale` | ✅ | 补丁打上了（后者=旧体原地重建成功） |
| `turnid-already-patched` | ✅ | 幂等命中，无需动作 |
| `turnid-reverted` / `turnid-revert-noop` | ✅ | 回滚成功 / 本来就没补丁所以跳过 |
| `turnid-anchor-mismatch` / `turnid-anchor-context-mismatch` / `turnid-partially-patched` | ❌ | 上游改了重放调用 / 上下文不对 / 半打补丁 → 需人工 |
| `turnid-target-missing` | ❌ | paseo 没装或路径变了 |
| `turnid-stale-anchor-mismatch` | ❌ | 旧体无法原地重建（区域里不是恰好一条重放调用，或缺 `});`） |
| `turnid-write-failed` | ❌ | 磁盘满/权限问题，**目标文件未被破坏**（原子写保证） |
| `turnid-syntax-check-failed` | ❌ | 补丁内容语法错，已还原干净内容 |
| `turnid-syntax-check-unavailable` | ❌ | **校验器跑不起来**（tmpdir 权限/磁盘满），不是补丁语法问题 |
| `unhandled` | ❌ | 未预期异常（代码 bug），状态未知需人工确认 |

`turnid-write-failed` / `turnid-syntax-check-unavailable` 这几个是**环境问题**，
不是「补丁写错了」—— 排查方向不同，别混。

## 附：为什么 `ExecStartPre` 带 `-` 前缀

不带 `-` 时，`ExecStartPre` 失败 = 服务不启动。叠加 `Restart=always` + `RestartSec=5`，
就是每 5 秒重试、永远失败，daemon 彻底起不来 —— 这正是升级后最糟的结果。

带 `-` 后，实测（`systemd-run --user` 一次性 unit）：

```
ExecStartPre=/tmp/.../fail.sh    → Result=exit-code，ExecStart 未执行（marker 文件不存在）
ExecStartPre=-/tmp/.../fail.sh   → Result=success，ExecStart 执行了（marker 内容 EXECSTART-RAN）
```

补丁脚本**自己**仍然 fail loud（exit 1 + stderr + 状态文件），只是不再拖垮 daemon。
