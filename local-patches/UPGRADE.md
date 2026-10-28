# paseo 升级后怎么办

面向「以后 `npm i -g @getpaseo/cli` 之后要做什么」的操作手册。

**一句话结论：正常情况下什么都不用做。** 升级后第一次启动 daemon 时，`ExecStartPre`
会自动把补丁重新打上（锚点自适配，不管上游改了什么无关字节、换了缩进还是换了行尾）。
只有锚点真的失配时才需要人工介入，而且那时 daemon 仍然能起来，只是撤回功能降级。

---

## 0. 先理解三个东西

| 文件 | 作用 |
|---|---|
| `~/.paseo/local-patches/apply-rewind-history-truncation.mjs` | 给 `plugin-provider.js` 打补丁（截断 `this.history`，让撤回后时间线立即刷新）。幂等，可反复跑 |
| `~/.config/systemd/user/paseo.service.d/10-rewind-patch-soft-fail.conf` | 让上面那个脚本作为 `ExecStartPre` 运行，且**失败不阻止 daemon 启动**（`-` 前缀） |
| `~/.paseo/local-patches/check-rewind-patch.mjs` | 只读体检：补丁现在到底有没有生效 |

补丁改的是**全局安装的 paseo**，不是仓库：

```
~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/
  dist/server/server/agent/plugin-provider.js
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
node ~/.paseo/local-patches/check-rewind-patch.mjs
```

### 按 exit code 分支

**先说清楚：`check-rewind-patch.mjs` 和 `apply-rewind-history-truncation.mjs` 各有一套 exit code，
数字含义不同，别混用。**

`check-rewind-patch.mjs`（只读体检）：

| exit | 含义 | 该做什么 |
|---|---|---|
| `0` | 补丁在位且实现体是最新的 | 无需动作，直接重启 |
| `1` | 需要跑一次 apply。两种情形：① 补丁不在位但锚点各命中 1 次（可自动打）；② 标记齐全但**实现体是旧版**（`state: stale-body`，需重建）。**要区分请看 `state`，不要只看 exit code** | 也无需动作：下次启动 daemon 时 `ExecStartPre` 会自动打上。想立刻确认就手动跑一次 `node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs` |
| `2` | 锚点失配 / 半打补丁 → **需人工** | 见下面第 3 节 |
| `3` | 目标文件不存在 | paseo 可能没装好，或安装路径变了。先 `which paseo` / 确认 `@getpaseo/server` 是否在预期位置 |
| `4` | **上游已自行修好撤回** → 补丁该退休 | 按第 5 节删掉补丁。别让它继续滞留（否则每次撤回都刷一条假告警） |

`apply-rewind-history-truncation.mjs`（会写文件，`ExecStartPre` 与启动钩子跑的就是它）：

| exit | 含义 | 该做什么 |
|---|---|---|
| `0` | 三个 target 全部到位（`rewind` / `turnId` / `childRunning`） | 无需动作 |
| `1` | 至少一个 target **失败**（锚点失配、半打、写失败等） | 看 stderr 里点名的 target，按第 3 节处理 |
| `3` | **DEGRADED**：补丁在、也能用，但实现体是旧版且**无法自动重建**（缺该上游版本的干净基线） | 已知后果只有一条：**同一会话里的第二次撤回**会报 `No provider revert token`。修法：重装 `@getpaseo/cli`（恢复干净文件）后重跑本脚本。启动钩子会单独记一行 `DEGRADED (exit 3)`，不会写成 FAILED |

⚠️ 上表 `3` 与 `check` 的 `3` **是两回事**：`check` 的 3 是"文件不存在"，`apply` 的 3 是"DEGRADED"。

⚠️ `check-rewind-patch.mjs` 的 exit code **只反映 rewind 一个 target**。`childRunning` 与 `turnId`
的结果在输出的「同文件姊妹补丁」一节 / `--json` 的 `siblings` + `siblingsAllOk` 里。
**不要只看 exit code 判断整机健康**——姊妹补丁缺失不会改变 exit code。

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

补丁靠两个**结构锚点**定位插入点（不是靠 md5）。两个都必须**恰好命中 1 次**：

- **ANCHOR_A**：`publish(event)` 方法（带 `this.history.push(event); this.emit(event);` 三行体）
  —— 补丁把 `truncateHistoryFrom()` 方法插在它前面
- **ANCHOR_B**：`revert()` 尾部那整个 `await this.bridge.revert({...});` 调用 + 收尾 `}`
  —— 补丁把截断调用插在 `}` 前面

两者都是**空白弹性正则**（`[ \t]*` + `\r?\n` 容错），所以上游改缩进（4→2 空格）、换 Tab、
换 CRLF 都能自动适配。失配只有两种真原因：**插入点被删/被改写**，或**出现歧义（>1 次）**。

### 诊断

```bash
# 看 check 报出的实际命中数
node ~/.paseo/local-patches/check-rewind-patch.mjs

# 直接看上游现在长什么样
T=~/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js
grep -n 'publish(event) {' "$T"
grep -n 'await this.bridge.revert({' "$T"
grep -n 'LOCAL PATCH (paseo-dsh)' "$T"     # 应为 0（干净）或 2（已打）
```

### 修法

1. 把 `~/.paseo/local-patches/apply-rewind-history-truncation.mjs` 里的 `ANCHOR_A_RE` /
   `ANCHOR_B_RE` 按新形状改正则。要求不变：**保留完整的函数体作为判据**（否则会误命中文件里
   另一个同名 `publish(event)`），**保留缩进捕获组**（插入时要复用它）。
2. 用临时副本验证，别直接打真文件：
   ```bash
   cp "$T" /tmp/pp.js
   REWIND_PATCH_TARGET=/tmp/pp.js node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
   # 期望 exit 0 + ESM syntax ok
   ```
3. 验证通过再打真的：
   ```bash
   node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs
   ```
4. 如果上游**已经自己修好了**撤回（见第 5 节），那就别修锚点了，直接删补丁。

> `BASE_MD5` 不再参与判定，只是记录「当前文件离基线多远」。上游改一个无关字节**不该**被当成故障，
> 这正是这版脚本的设计意图。所以**不要**为了「让 md5 对上」去改 `BASE_MD5`。

---

## 4. 降级了是什么表现

补丁没生效时（exit 2 / 3，或 `ExecStartPre` 失败），撤回功能退化为「旧行为」：

- 撤回**会成功**，消息数据**不会丢**；
- 但**时间线不会自动刷新** —— 被撤回的消息在界面上**还看得见**；
- **重开会话**（或 `paseo agent reload`）之后，被撤回的消息才消失。

也就是说：功能降级，数据无损。这不是紧急故障，可以等有空再修。

---

## 5. 什么时候可以彻底删掉补丁

上游修好 [paseo#4667](https://github.com/getpaseo/paseo/issues/4667)（插件 provider 的
`streamHistory()` 在撤回后不缩短）之后，这个补丁就该退休了。判断依据：**新版
`plugin-provider.js` 里 `revert()` 自己就截断了 `this.history`**（而不是像现在这样只发
`bridge.revert` 请求、然后指望 daemon 重建时间线时读到缩短后的数组）。

> **别自己 grep 判断——用 exit code 4。** 手工 grep 在**补丁在位时必然误判**：补丁自己插入的
> `truncateHistoryFrom` 调用就在 `revert()` 里，那几行也含 `this.history` 字样。所以判定必须
> 由下面这条命令做（它只在 marker==0 的干净文件上判定，天然排除补丁自己的文本）：

```bash
# 1. 一条命令判定：exit 4 = 上游已自修，补丁该退休
node ~/.paseo/local-patches/check-rewind-patch.mjs; echo "exit=$?"
```

看到 `state: upstream-fixed-retire-patch` / `exit 4` 才继续往下走。
若输出是 `exit 0`（补丁在位）或 `exit 2`（锚点失配），**上游还没修**，不要去删补丁。

<details>
<summary>为什么不能手工 grep（想看原理再展开）</summary>

`revert()` 方法体在**已打补丁**的文件里长这样（补丁自己插了 3 行）：

```
        // LOCAL PATCH (paseo-dsh): the force-hydrate that follows this reply reads
        // `streamHistory()`, i.e. `this.history`.  Shorten it now so the rebuilt
        if (!this.truncateHistoryFrom(messageId)) {
```

拿这些行去 grep `this\.history` 会命中，于是把**自己写的补丁**判成「上游已自修」。
检测函数用的是「只在 marker==0 时判定」+「bound 在 `revert()` 方法体内」，两条一起才不误判。

</details>

届时按这个顺序删（先验证再删，别反过来）：

```bash
# 2. 真机验证：撤回一条消息 → 界面立即消失、无 /rewind 残留行、编辑工具改的文件恢复
#    （用新会话，能力位只对新会话生效）

# 3. 删 drop-in（此时先别删 paseo.service 本体里的 ExecStartPre，见下）
rm ~/.config/systemd/user/paseo.service.d/10-rewind-patch-soft-fail.conf
systemctl --user daemon-reload
systemctl --user show paseo.service -p ExecStartPre     # 应只剩 paseo.service 本体里那条
```

第 3 步之后还要处理 `paseo.service` **本体**里的 `ExecStartPre` 行（那是更早写进去的）：
把 `ExecStartPre=/usr/bin/node $HOME/.paseo/local-patches/apply-rewind-history-truncation.mjs`
整行删掉，再 `daemon-reload`。删完 `rm ~/.paseo/local-patches/apply-rewind-history-truncation.mjs`
（备份 `plugin-provider.js.orig-*` 建议留一份再删，它们是回滚材料）。

---

## 6. 回滚补丁（想临时恢复官方行为）

```bash
node ~/.paseo/local-patches/apply-rewind-history-truncation.mjs --revert
```

行为：
- 从**最近一次成功打补丁时记录的备份**还原（优先用 `rewind-patch.status.json` 里记的 `backup`，
  回退到最新的 `plugin-provider.js.orig-*`）；
- **原子写**：先写同目录临时文件再 `renameSync` 覆盖。所以还原失败时目标文件要么是完整的旧
  （已打补丁）内容、要么是完整的干净内容，**不会**出现半截文件；
- 还原后校验 **MARKER 计数 == 0**（确实是干净未打补丁状态）+ **ESM 语法检查通过**；
- **不再**要求 md5 等于 `BASE_MD5` —— 上游升级后那条旧校验会让回滚永远失败；
- 任何一步失败都会把**回滚前的已打补丁内容放回去**；连这个都写不进去时，
  `status.json` 会记 `rollbackSucceeded: false` 并明说「目标文件可能已是备份内容、期望 md5 是 X」，
  不会假装成功。

**幂等**：如果目标文件本来就没有补丁标记（比如刚升级完、还没打过），`--revert` 会直接
跳过（`reason: revert-noop`），**不会**用旧备份覆盖新上游文件。

> 注意 `--revert` 只是撤销补丁，**不会**改 drop-in。所以下次启动 daemon 时
> `ExecStartPre` 又会把补丁打上。要真正保持官方行为，得同时把 drop-in 里的那行注释掉。

---

## 附：状态文件

`~/.paseo/local-patches/rewind-patch.status.json`，每次运行 `apply` 都写（成功也写，
这样「上次成功」和「从没成功」可区分）。**任何**失败都会留下状态文件，包括未预期异常
（`reason: unhandled`）—— 不会出现「崩栈了但状态文件还停在上一次 ok:true」的假绿。

```json
{
  "ok": true,
  "at": "2026-10-26T06:05:52.086Z",
  "reason": "already-patched | patched | patched-on-new-upstream | reverted | revert-noop | upstream-fixed-retire-patch | anchor-mismatch | partially-patched | target-missing | write-failed | revert-write-failed | syntax-check-failed | syntax-check-unavailable | unhandled",
  "target": "<被改的文件>",
  "targetMd5": "<改完之后的 md5>",
  "baseMd5": "<已知基线，仅参考>",
  "paseoVersion": "<@getpaseo/cli 版本，读不到为 null>",
  "message": "<给人看的一句话>",
  "upstreamMd5": "<打补丁前上游的 md5>",
  "backup": "<这次用的备份路径>",
  "anchorA": 1, "anchorB": 1,
  "indentUnit": "4 | 2 | tab",
  "restoredCleanly": true,
  "rollbackSucceeded": true
}
```

`reason` 分类：

| reason | ok | 含义 |
|---|---|---|
| `patched` / `patched-on-new-upstream` | ✅ | 补丁打上了（后者=上游变了但锚点自适配成功，**这是期望行为**） |
| `already-patched` | ✅ | 幂等命中，无需动作 |
| `reverted` / `revert-noop` | ✅ | 回滚成功 / 本来就没补丁所以跳过 |
| `upstream-fixed-retire-patch` | ❌ | 上游自己修好了 → **该删补丁**（exit 4） |
| `anchor-mismatch` / `partially-patched` | ❌ | 插入点变了 / 半打补丁 → 需人工 |
| `target-missing` | ❌ | paseo 没装或路径变了 |
| `write-failed` / `revert-write-failed` | ❌ | 磁盘满/权限问题，**目标文件未被破坏**（原子写保证） |
| `syntax-check-failed` | ❌ | 补丁内容语法错，已还原干净内容 |
| `syntax-check-unavailable` | ❌ | **校验器跑不起来**（tmpdir 权限/磁盘满），不是补丁语法问题 |
| `unhandled` | ❌ | 未预期异常（代码 bug），状态未知需人工确认 |

`write-failed` / `revert-write-failed` / `syntax-check-unavailable` 这几个是**环境问题**，
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
