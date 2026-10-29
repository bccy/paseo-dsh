# local-patches —— Paseo 宿主侧本地补丁套件

给 **Paseo 本体**（`@getpaseo/server` 的 `dist`）打两个补丁，修两个 Paseo 自己的缺陷。
补丁以**脚本**形式存在，而不是直接改 `node_modules`：`npm i -g @getpaseo/cli` 会整树覆盖
`dist`，所以改动必须在每次 daemon 启动时自动重打。

| target | 改哪个文件 | 修什么 |
|---|---|---|
| `rewind` | `plugin-provider.js` | 撤回后时间线不刷新，要重开会话才看到消息消失 |
| `turnId` | `agent-manager.js` | 重开会话后长对话的回合折叠失效（`turnId` 在重放时丢失） |

两个 target 改**不同文件**，互不影响。

> **已退役：`childRunning`。** 子代理第二次被派发时不显示「运行中」这个缺陷（原 issue
> [#8077](https://github.com/getpaseo/paseo/issues/8077)）已由上游
> [getpaseo/paseo#8080](https://github.com/getpaseo/paseo/pull/8080) 修复（已合 main）。
> **发版前**升级到含它的 Paseo 之前，二次派发的子代理仍不会显示 running——那段时间
> 接受这个降级，补丁不再维护。
>
> 老版本打过它的机器：新版脚本**不认识**那个 marker，也不会主动清它（`--revert` 按整文件备份
> 还原，结果取决于备份代次，别指望它顺手清掉）。要清掉就用**旧版脚本** `--revert` 一次，或
> 重装 `npm i -g @getpaseo/cli` 拿回干净文件。留着不影响 `rewind` / `turnId` 的正确性。

## 文件

| 文件 | 作用 |
|---|---|
| `apply-rewind-history-truncation.mjs` | 打补丁 / `--revert` / `--check`。幂等，锚点自适配，原子写 |
| `check-rewind-patch.mjs` | **只读**体检：现在什么状态、要不要动手、姊妹补丁在不在位 |
| `startup-patch-hook.cjs` | 启动钩子：**只在 Paseo daemon 进程链里**（supervisor / worker）跑一次 apply |
| `UPGRADE.md` | 升级 Paseo 后的处置手册 + exit code 对照 |

## 装法

两条重打路径，**都装**才完整：

1. **systemd `ExecStartPre`**（`-` 前缀 = 软失败，补丁失败不阻塞 daemon 启动）
   ```
   ExecStartPre=-/usr/bin/node %h/.paseo/local-patches/apply-rewind-history-truncation.mjs
   ```
2. **`NODE_OPTIONS` 启动钩子**（覆盖「App 内升级」：supervisor 在进程树内 fork 新 worker，
   systemd 看不见那条路径）
   ```
   Environment="NODE_OPTIONS=--require %h/.paseo/local-patches/startup-patch-hook.cjs"
   ```

`startup-patch-hook.cjs` 会把自身从给子进程的 `NODE_OPTIONS` 里剥掉（否则 patch 脚本这个
node 进程会再次加载钩子），并用模块级变量防同进程重入。**不要**用环境变量做跨进程的
「已经跑过」标记——supervisor fork worker 时会继承它，worker 就被误挡掉了。

钩子还按 `process.argv[1]` 做了**入口白名单**，只有 `supervisor-entrypoint.js` /
`daemon-worker.js` / `node-entrypoint-runner.js` 会真的跑 apply，其它 node 进程（terminal
worker、plugin process、DSH 桥、git helper）**直接 return**。原因有两条，都实测过：

1. `NODE_OPTIONS` 会被 daemon 派生的每个 node 子进程继承。没有白名单时，在继承了这个环境的
   shell 里跑 `check-rewind-patch.mjs`（本文件称它为「只读体检」）会先被钩子打上补丁，然后
   报告「补丁在位」——**只读工具在本机恒绿**。同一条命令、同一份文件，`env -u NODE_OPTIONS`
   说 `NOT patched / exit 1`，带继承环境说 `patched / exit 0`。`UPGRADE.md` 的每个分支都建立
   在这个答案上。
2. 开销：每个 node 进程启动多 60~160 ms（实测 `node -e '0'`：无钩子 29 ms，带钩子
   91/97/187 ms），日志两天涨到 1584 行 / 1082 个 pid。

日志现在有上限：超过 500 行时截断重写，只保留最新的（`startup-patch-hook.log` 原来没有任何
上限）。

## 用法

```bash
node check-rewind-patch.mjs          # 只读体检
node check-rewind-patch.mjs --json   # 机器读
node apply-rewind-history-truncation.mjs            # 打补丁（幂等）
node apply-rewind-history-truncation.mjs --check    # 只读：三个 target 是否都在位
node apply-rewind-history-truncation.mjs --revert   # 全部回滚
```

退出码见 `UPGRADE.md`。要点：`check` 与 `apply` 各有一套 exit code，数字含义不同；
`apply` 的 `3` 是 DEGRADED（补丁在、体是旧的、重建失败），`check` 的 `3` 是目标文件不存在。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PASEO_CLI_ROOT` | 从 PATH 上的 `paseo` 可执行文件 realpath 推导 | `@getpaseo/cli` 安装根目录 |
| `REWIND_PATCH_TARGET` | 由 `PASEO_CLI_ROOT` 推出 | 覆盖 `plugin-provider.js` 路径（测试用） |
| `REWIND_PATCH_TURNID_TARGET` | 由 `PASEO_CLI_ROOT` 推出 | 覆盖 `agent-manager.js` 路径（测试用） |
| `REWIND_PATCH_HOME` | 脚本所在目录 | **所有**备份与 `rewind-patch.status.json` 的位置 |

> **这些是模块顶层常量，在 import 时求值**——必须在启动 node 时就注入，不能在 import 之后改。

## 设计上踩过的坑（都实测过，改之前先读）

1. **幂等不能只看 marker 数。** 注入的方法体是这个脚本的一部分；改好脚本后，存量安装的
   marker 数仍然是 2，只看计数就会永远报 `already-patched`，修好的体永远进不去。两个 target
   都改为「marker 定位 + 逐行比对代码行」。
   **rewind 的判据必须同时覆盖 `METHOD` 和 `CALL` 两块**：只比对方法体时，`revert()` 里那
   段调用被降级（或删到只剩注释）仍会报「body current」，修好的调用永远进不到存量安装；
   更糟的是删掉调用后文件仍能解析、marker 仍是 2，两个检查工具全绿而补丁其实是空的。
2. **陈旧体重打必须「先算完再一次写」。** 先写盘再递归重跑，一旦重跑失败，文件就停在
   marker=0 的半成品上，而 `--revert` 按 marker 数判断会走 noop——备份就在旁边也不看。
3. **不要用整文件基线覆盖来重建。** 那需要判断「这份备份是不是同一上游版本」，而任何
   版本比对启发式都有盲区（第一版剥了 rewind 补丁却没剥同文件里的另一个补丁，共存时必然误判）。
   现在改为**只替换目标块**（方法体 + `revert()` 里的调用），文件里别的东西一律不碰。
4. **备份命名空间必须不相交。** rewind 的基线查找按 `plugin-provider.js.orig-` 前缀筛；
   turnId 的 `.orig-turnid-` 与 prestale 备份若也以此开头，会被当成 rewind 基线选中（而它带着
   marker），导致 revert 永久失效。且 `latestBackup()` 显式排除 prestale。
5. **备份一律写在 `BACKUP_DIR`（`REWIND_PATCH_HOME`），不要写进目标文件所在的 dist 目录。**
   `npm i -g @getpaseo/cli` 整树替换 `dist`，备份会随之消失——偏偏那正是需要回滚的时刻。
   跨 target 误恢复靠的是**文件名前缀**（两个前缀不相交）与 revert 时「备份自己带 marker 就
   拒绝」，不是靠目录隔离。
6. **CRLF 文件**：签名正则的 `\r?` 会把 `\r` 计入匹配长度，用「匹配末尾 - 1」定位开括号
   会落在 `\r` 上。必须用 `indexOf("{")` 找开括号。

## 已知限制

- 只针对 `@getpaseo/server` 的 `dist` 结构。上游改了插入点会 fail closed（报锚点失配），
  不会静默打错位置。
- 补丁注入的 `truncateHistoryFrom()` 直接读宿主三个私有字段（`this.history`、
  `this.timelineSnapshots`、`this.revertTokens`）。上游若改名/重构，apply 会以
  `host-fields-changed` **fail closed、不写文件**（否则补丁照打，然后每次撤回抛 TypeError）。
- 上游 #7675（把 `this.history` 换成 `PluginSessionHistory` 对象）一旦落地，注入体会变成
  运行时 no-op：文件里出现 `new PluginSessionHistory(` 或 `this.history.read(` 时 apply 以
  `upstream-history-shape-changed` exit 1 并写明原因——那时该退役或重写这个 target。
- `--check` 只读，不写 status，也不写目标文件。
- `check-rewind-patch.mjs` 的 exit code 现在会因**姊妹补丁**（`turnId`）缺失而升高
  （`--json` 里 `code` 仍是 rewind 自己的判定，合并结果看 `exitCode` / `siblingsAllOk`）。
