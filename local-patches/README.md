# local-patches —— Paseo 宿主侧本地补丁

给 **Paseo 本体**（`@getpaseo/server` 的 `dist`）打一个补丁，修一个 Paseo 自己的缺陷。
补丁以**脚本**形式存在，而不是直接改 `node_modules`：`npm i -g @getpaseo/cli` 会整树覆盖
`dist`，所以改动必须在每次 daemon 启动时自动重打。

| target | 改哪个文件 | 修什么 | 状态 |
|---|---|---|---|
| `turnId` | `agent-manager.js` | 重开会话后长对话的回合折叠失效（`turnId` 在重放时丢失） | **保留**：Paseo 0.15.0 仍未修 |
| `rewind` | `plugin-provider.js` | 撤回后时间线不刷新，要重开会话才看到消息消失（#4667） | **已退休**：Paseo 0.15.0 原生修好（PR #8368） |

> **rewind 退休说明。** 0.15.0 的 `PluginAgentSession.revert()` 会关掉旧 provider 会话、
> 带 persistence handle 重开并按 DSH 持久化会话重放，时间线自动变短；而旧补丁注入的
> `truncateHistoryFrom()` 依赖的 `this.history` 数组已被 `PluginSessionHistory` 取代
> （PR #7675），打上去只会是运行期 no-op。所以 rewind target 从脚本删除，
> `plugin-provider.js` 不再被触碰。**回滚到 Paseo 0.14.0 时**撤回仍然生效，只是时间线不再
> 自动刷新——靠 canary 提示用户 Reload/重开，这是可接受的降级，见 `UPGRADE.md` §7。
> 升级前在旧机器上留下的 rewind 补丁会随 `npm i -g @getpaseo/cli` 整树替换自然消失；
> 若想立刻清掉，用**旧版**脚本跑一次 `--revert`，或重装 CLI。

## 文件

| 文件 | 作用 |
|---|---|
| `apply-rewind-history-truncation.mjs` | 打 turnId 补丁 / `--revert` / `--check`。幂等，锚点自适配，原子写。文件名是历史名（systemd/钩子指向它），**现在只处理 turnId** |
| `check-rewind-patch.mjs` | **只读**体检：补丁现在什么状态、要不要动手 |
| `startup-patch-hook.cjs` | 启动钩子：**只在 Paseo daemon 进程链里**（supervisor / worker）跑一次 apply |
| `UPGRADE.md` | 升级 Paseo 后的处置手册 + exit code 对照 + 回滚 |

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

日志有上限：超过 500 行时截断重写，只保留最新的（`startup-patch-hook.log` 原来没有任何上限）。

### 部署：仓库是唯一事实源

本目录（仓库里的 `local-patches/`）是**唯一事实源**，daemon 实际加载的是部署副本
`$HOME/.paseo/local-patches/`。改完脚本必须**同步过去**，否则下次 daemon 启动跑的仍是旧脚本：

```bash
# 1. 先用仓库里的新脚本只读检查一遍（--check 只读，不改真机文件）
env -u NODE_OPTIONS node local-patches/apply-rewind-history-truncation.mjs --check

# 2. 同步到部署位置（~ 展开成你的 home，别写死用户名）
mkdir -p ~/.paseo/local-patches
cp local-patches/*.mjs local-patches/*.cjs ~/.paseo/local-patches/

# 3. 体检部署副本，确认状态
env -u NODE_OPTIONS node ~/.paseo/local-patches/check-rewind-patch.mjs
```

第 2 步**只拷脚本，不拷备份与状态文件**（`agent-manager.js.orig-turnid-*`、
`rewind-patch.status.json` 属于本机状态，部署副本自己会写）。systemd 的 `ExecStartPre` 与
`NODE_OPTIONS` 钩子都指向部署副本，所以同步完还要重启 daemon 才会真正生效。

⚠️ **`apply` 与 `check` 必须一起同步。** 新版 `check-rewind-patch.mjs` 直接 import
`apply-rewind-history-truncation.mjs` 导出的 `turnIdStaleness` / `turnIdRebuildPlan`（实现体
新旧判定与 stale 重建可行性两处共用同一段代码）。只换其中一个会让 checker 在 `import` 阶段
就失败；而 `ExecStartPre` 带 `-` 前缀是软失败，体检工具坏掉时 daemon 仍会启动，补丁却可能停在
半态。`cp local-patches/*.mjs local-patches/*.cjs ~/.paseo/local-patches/` 一次拷全即满足。

### 从旧版本升级（本机部署副本带 rewind target）

新脚本**不认识** rewind 的 marker，也不会主动清 `plugin-provider.js` 上的旧补丁。处置分两种：

- **要升到 Paseo 0.15.0**：直接 `npm i -g @getpaseo/cli@0.15.0`（整树替换 dist，旧 rewind
  补丁自然消失），同步新脚本、重启即可。不要在新版本上继续打 rewind。
- **暂时留在 0.14.0**：旧 rewind 补丁留在 dist 上仍然工作，但不再维护；想清掉就用**旧版**
  脚本 `--revert` 一次，或重装 CLI 拿回干净文件再跑新 apply。新脚本的 `--revert` 只处理
  turnId，不会碰 `plugin-provider.js`。

顺序：**同步新脚本 → apply（只打 turnId）→ 重启 daemon**。turnId 的备份前缀
`.orig-turnid-` 与 rewind 的 `.orig-` 不相交，两代备份可以共存。

## 用法

```bash
node check-rewind-patch.mjs          # 只读体检
node check-rewind-patch.mjs --json   # 机器读
node apply-rewind-history-truncation.mjs            # 打补丁（幂等）
node apply-rewind-history-truncation.mjs --check    # 只读：turnId 补丁是否在位且体是最新的
node apply-rewind-history-truncation.mjs --revert   # 回滚 turnId 补丁
```

退出码见 `UPGRADE.md` §2。要点：`check` 与 `apply` 的 exit code 含义不同；
`check` / `apply --check` 的 `1` 是「跑一次 apply 就好」，`2` 是「需要人工，apply 会拒绝」，
`3` 是「目标文件不存在」。旧的 `4`（上游已自修、该退休）与 `apply 3`（DEGRADED）随 rewind
target 一起删除。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PASEO_CLI_ROOT` | 从 PATH 上的 `paseo` 可执行文件 realpath 推导 | `@getpaseo/cli` 安装根目录 |
| `REWIND_PATCH_TURNID_TARGET` | 由 `PASEO_CLI_ROOT` 推出 | 覆盖 `agent-manager.js` 路径（测试用；变量名是历史名） |
| `REWIND_PATCH_HOME` | 脚本所在目录 | **所有**备份与 `rewind-patch.status.json` 的位置（变量名是历史名） |

> 旧的 `REWIND_PATCH_TARGET`（覆盖 `plugin-provider.js`）随 rewind target 删除，设了也不再生效。
>
> **这些是模块顶层常量，在 import 时求值**——必须在启动 node 时就注入，不能在 import 之后改。

## 设计上踩过的坑（都实测过，改之前先读）

1. **幂等不能只看 marker 数。** 注入的实现体是这个脚本的一部分；改好脚本后，存量安装的
   marker 数仍然是 2，只看计数就会永远报 `already-patched`，修好的体永远进不去。所以改为
   「marker 定位 + 逐行比对代码行」；**体是旧版但 marker 2/2** 时原地重建，重建前先做内存
   语法校验，重建后必须与干净重打逐字节一致。
2. **陈旧体重打必须「先算完再一次写」。** 先写盘再递归重跑，一旦重跑失败，文件就停在
   marker=0 的半成品上。现在整段重建在内存里完成（含结构守卫与语法校验），失败时文件不动。
3. **重建区域必须有结构守卫。** 「最近一个同缩进的 `});`」会把后面的无关语句一起吞掉；
   所以先要求区域内**恰好一条**重放调用（`const row = this.recordTimeline(agent.id, event.item`），
   否则 fail closed。这是 `local-patches-check.mjs` 里「unrebuildable」用例的来源。
4. **备份一律写在 `BACKUP_DIR`（`REWIND_PATCH_HOME`），不要写进目标文件所在的 dist 目录。**
   `npm i -g @getpaseo/cli` 整树替换 `dist`，备份会随之消失——偏偏那正是需要回滚的时刻。
   还原时「备份自己带 marker 就拒绝」，不靠目录隔离。
5. **`apply` 与 `check` 同源判定。** checker 不能承诺 apply 会拒绝的重建（LP-02）：
   stale 重建可行性由同一个 `turnIdRebuildPlan()` 回答，且它真的在内存里跑一遍语法校验。

## 已知限制

- 只针对 `@getpaseo/server` 的 `dist` 结构。上游改了插入点/上下文会 fail closed（报锚点失配），
  不会静默打错位置。
- 只修「重放时丢 `turnId`」。`turnId` 缺失只影响「重开会话后长对话是否折叠轮次」，不影响
  撤回、不影响数据。
- `--check` 只读，不写 status，也不写目标文件。
- 状态文件名沿用 `rewind-patch.status.json`（部署接线与文档已按这个名字约定；脚本现在只写
  turnId 的判定）。
