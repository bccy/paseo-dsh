# local-patches —— Paseo 宿主侧本地补丁套件

给 **Paseo 本体**（`@getpaseo/server` 的 `dist`）打三个补丁，修三个 Paseo 自己的缺陷。
补丁以**脚本**形式存在，而不是直接改 `node_modules`：`npm i -g @getpaseo/cli` 会整树覆盖
`dist`，所以改动必须在每次 daemon 启动时自动重打。

| target | 改哪个文件 | 修什么 |
|---|---|---|
| `rewind` | `plugin-provider.js` | 撤回后时间线不刷新，要重开会话才看到消息消失 |
| `childRunning` | `plugin-provider.js` | 子代理**第二次**被派发时不显示「运行中」（见 [issue #8077](https://github.com/getpaseo/paseo/issues/8077)） |
| `turnId` | `agent-manager.js` | 重开会话后长对话的回合折叠失效（`turnId` 在重放时丢失） |

`rewind` 与 `childRunning` 改**同一个文件**，所以脚本串行读改写，两者的 marker 互不为前缀。

## 文件

| 文件 | 作用 |
|---|---|
| `apply-rewind-history-truncation.mjs` | 打补丁 / `--revert` / `--check`。幂等，锚点自适配，原子写 |
| `check-rewind-patch.mjs` | **只读**体检：现在什么状态、要不要动手、姊妹补丁在不在位 |
| `startup-patch-hook.cjs` | 启动钩子：daemon 启动时跑一次 apply |
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
| `REWIND_PATCH_CHILDRUNNING_TARGET` | 跟随 `TARGET` | 覆盖 childRunning 目标（测试用） |
| `REWIND_PATCH_TURNID_TARGET` | 由 `PASEO_CLI_ROOT` 推出 | 覆盖 `agent-manager.js` 路径（测试用） |
| `REWIND_PATCH_HOME` | 脚本所在目录 | 备份与 `rewind-patch.status.json` 的位置 |

> **这些是模块顶层常量，在 import 时求值**——必须在启动 node 时就注入，不能在 import 之后改。

## 设计上踩过的坑（都实测过，改之前先读）

1. **幂等不能只看 marker 数。** 注入的方法体是这个脚本的一部分；改好脚本后，存量安装的
   marker 数仍然是 2，只看计数就会永远报 `already-patched`，修好的体永远进不去。三个 target
   都改为「marker 定位 + 逐行比对代码行」。
2. **陈旧体重打必须「先算完再一次写」。** 先写盘再递归重跑，一旦重跑失败，文件就停在
   marker=0 的半成品上，而 `--revert` 按 marker 数判断会走 noop——备份就在旁边也不看。
3. **不要用整文件基线覆盖来重建。** 那需要判断「这份备份是不是同一上游版本」，而任何
   版本比对启发式都有盲区（第一版剥了 rewind 补丁却没剥 childRunning，双补丁共存时必然误判）。
   现在改为**只替换目标方法块**，文件里别的东西（另一个补丁、上游改动）一律不碰。
4. **备份命名空间必须不相交。** rewind 的基线查找按 `plugin-provider.js.orig-` 前缀筛；
   childRunning 与 prestale 备份若也以此开头，会被当成 rewind 基线选中（而它带着 marker），
   导致 revert 永久失效。故 childRunning 用 `.childrunning-orig-`、prestale 用 `.prestale-`，
   且 `latestBackup()` 显式排除 prestale。
5. **`--revert` 顺序与 apply 相反。** 每个 target 的备份是整文件快照，rewind 先回滚会连带
   清掉 childRunning 补丁，使它误报 `revert-noop`（终态仍干净，但报告误导）。
6. **CRLF 文件**：签名正则的 `\r?` 会把 `\r` 计入匹配长度，用「匹配末尾 - 1」定位开括号
   会落在 `\r` 上。必须用 `indexOf("{")` 找开括号。

## 已知限制

- 只针对 `@getpaseo/server` 的 `dist` 结构。上游改了插入点会 fail closed（报锚点失配），
  不会静默打错位置。
- `childRunning` 的残余风险：子会话发出 `started` 后进程崩溃且不发终态，子卡会停在
  `running`。首次 `attachChild` 本来就有这个窗口，父 agent 关闭时
  `cancelRunningProviderSubagents()` 会兜底改 `canceled`。
- `--check` 只读，不写 status，也不写目标文件。
