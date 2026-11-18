# Windows 进程兼容

本 fork 的 provider、`doctor` 与 harness 都支持 Windows 上 `npm -g` 安装的官方
`@deepseek-ai/dsh`：启动器在**daemon / 会话提供的 PATH**（或插件进程的 `DSH_BINARY` 覆盖）
里找到 npm 生成的 `dsh.cmd`，读取该安装 `package.json` 的 `bin` 入口，然后用 Node 直接执行。
参数始终是 argv 数组，**不经过任何命令 shell**；npm 同目录的 `node.exe` 优先，没有才用 PATH
上的 `node.exe`。

这样 DSH 子进程的 stdin/stdout/stderr 管道和现有的终止逻辑保持不变。会话启动环境会提供
PATH 与 `DSH_PASEO_PROFILE`；`DSH_BINARY` 从插件进程（daemon）环境读取，和 catalog 指纹
使用同一条规则（避免 spawn 与指纹分叉）。macOS/Linux 以及原生可执行文件覆盖保持原来的
启动命令不变。不是官方 npm 布局的自定义 Windows 命令包装器不会被当作 npm 启动器解析；
解析失败时 spawn 错误会说明原因并指向本文档与 `DSH_BINARY`。

## 为什么直接执行 Node

Windows 上的 `spawn("dsh", ...)` 无法执行 npm 的 `.cmd` 启动器，
`execFileSync("dsh.cmd", ...)` 也会以 `EINVAL` 失败（见
[Node 关于 Windows 上启动 .bat/.cmd 的说明](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)）。
直接执行 Node 入口比插入一个 `cmd.exe` 更小：不增加 shell 进程，不需要为 shell 的子进程树
另写终止逻辑，不会让引号/`%PATH%`/`&` 之类的字符经过第二层解析，也不需要提高 Paseo SDK
的版本要求。

`DSH_BINARY` 仍然优先：它可以指向原生 `dsh.exe`（原样执行），也可以指向官方 npm 布局里的
`dsh.cmd`（解析成 Node 入口）。指向不存在的路径时 `doctor` 会明确失败，不会悄悄退回 PATH
上的另一个 `dsh`。

## 各入口共用同一个解析

`paseo-plugin/server/dsh-command.mjs` 是唯一的解析实现：

- `server/dsh-process.ts`：provider 真正的子进程启动；
- `lib/doctor.mjs`：`dsh --version` 与 `dsh --profile <p> --dump-config` 的探测；
- `server/catalog-cache.ts`：catalog 指纹里的 `dsh --version`；
- `harness/` 下所有会启动真实 `dsh` 的脚本（catalog、probe、route-test、stream-probe、
  rewind 系列、jobs、subagent、tools、archive、pnpm/isolated home、reload、p003、
  doctor-live 等）。

新增启动 DSH 的代码时走这一个函数，不要自己拼 `dsh.cmd` 或 `shell: true`。

## Windows 上的 doctor 行为

Windows 桌面版可以没有 PATH 上的 `paseo` CLI 而独立承载 provider，因此 `doctor` 找不到
`paseo` 时在 Windows 上是 **warning**（提示在应用内确认版本），在 macOS/Linux 上仍是
**fail**。DSH 缺失在任何平台都是 fail。`PASEO_CLI` 可以显式指定 CLI 可执行文件，`doctor`
会先试它，再试 `/Applications/Paseo.app`（macOS）和 PATH。

## 在本 fork 上安装 / 更新（Windows）

本仓库的插件通过 Paseo 的插件目录加载，不发布 npm 包：

```powershell
# 先备份 daemon 配置与现有 DSH profile；同 ID 已安装时先用 Paseo 移除旧安装。
& $env:PASEO_CLI plugin remove dsh-paseo
& $env:PASEO_CLI plugin install '<checkout>\paseo-plugin' --id dsh-paseo
& $env:PASEO_CLI plugin ls dsh-paseo --json
```

更新 checkouts 后：

```powershell
Set-Location '<checkout>'
git pull --ff-only origin main
npm --prefix paseo-plugin ci --ignore-scripts --no-audit --no-fund --replace-registry-host=always --registry=https://registry.npmjs.org/
npm --prefix paseo-plugin run typecheck
npm --prefix paseo-plugin run test:process
& $env:PASEO_CLI plugin reload dsh-paseo --json
```

桌面版的插件页面也接受插件目录路径并提供 Reload。目录源直接读 checkout，不会跟随 npm
上游包或 registry 列表更新。

## 回归检查

在 `paseo-plugin` 下运行（需要 Node 24 或更新版本；测试用 `harness/plugin-build.cjs` 把
TypeScript 编译成 CJS 后再加载）：

```bash
cd paseo-plugin && npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:process
```

`test/process.test.cjs` 使用一次性 npm 布局夹具，不需要凭据、profile 或模型调用。覆盖：
`dsh.cmd` shim → Node 入口解析、相邻 `node.exe` 优先、原生 `dsh.exe` 不被改写、入口缺失时
带说明失败（不回退为直接 spawn `.cmd`）、macOS/Linux 启动命令不变、`DSH_BINARY` 来自插件
进程环境且 spawn 与 catalog 指纹同源、argv/stdin/stderr/退出码原样传递、doctor 的 npm DSH
识别与 Windows `paseo` 警告。`.github/workflows/process-compatibility.yml` 在 Windows、
Linux、macOS 三平台跑同一组测试。

真实的模型回合仍由 `harness/plugin-check.cjs` 等真实 profile 检查覆盖（需要有效路由与凭据），
它不能替代本组进程级测试，本组也不能替代真实回合。
