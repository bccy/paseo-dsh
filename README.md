# DeepSeek Harness × Paseo（原生接入）

[中文](README.md) · [English](README.en.md)

> **来源与安装真相**：本分支继承自 [liuxing7954/paseo-dsh](https://github.com/liuxing7954/paseo-dsh)（MIT，原作者 jixy），由 **bccy** 维护；npm 上的 `paseo-dsh` 是**上游稳定线**，装它拿到的是上游代码，不含本分支的功能。
> **要装本分支**：`paseo plugin add github:bccy/paseo-dsh:paseo-plugin` —— 从 GitHub 源码安装，装到的才是本分支代码。

把 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 Paseo 的**一等公民 provider**
接进来。不 fork Paseo、不 fork DSH，全部走公开扩展点：Paseo 侧是 direct provider 插件，
DSH 侧是一个 profile bundle。

> 这不是 ACP 接入。ACP 缺三样东西，而 Paseo 的原生 provider 协议恰好都有。

**一行安装（本分支）：** `paseo plugin add github:bccy/paseo-dsh:paseo-plugin` · 仓库
[bccy/paseo-dsh](https://github.com/bccy/paseo-dsh) · 装完只差
[填模型路由](#安装推荐一行)，详见下方。

| 能力 | ACP 接入 | 本项目 |
| --- | --- | --- |
| `ask_user_question` 提问卡片 | ❌ 模型看不到该工具，也没有应答方 | ✅ Paseo 原生卡片，步进式选项，一次提交 |
| 计划模式 | ❌ ACP 不承载 modes/plans | ✅ 编辑器里的 Build / Plan 开关，计划先展示再审批 |
| 思考强度 | ⚠️ 取决于模型 | ✅ 按每个模型**真实声明**的档位渲染 |
| 插话（steer） | — | ✅ 注入当前回合，而不是排到下一个 |
| 图片（多模态） | ⚠️ 多数不承载 | ✅ 附件入库后按路由模态投递（需在 profile 声明图片模态） |
| 斜杠命令 / 技能 | ⚠️ 多为命令子集 | ✅ `/` 菜单列出 DSH 命令与 user-invocable 技能；命令在运行时执行，技能按 `/name` 注入 |
| 权限模式（沙箱） | ❌ 无统一开关 | ✅ composer 里的 **Permissions** 下拉，切换 DSH 的沙箱 + 审批预设 |
| 人设预设（Preset） | ❌ | ✅ profile 挂了 agent-preset registry 时，composer 出现 **Preset** 下拉（建会话时选、首回合后锁定） |
| 会话恢复 / 导入 | ❌ 无历史、无法导入 | ✅ 重开按 Paseo 的 `history: replay` 回放历史；**导入** DSH 原生会话（`session.list`，从 `~/.dsh/sessions` 列举） |
| 后台任务（jobs） | — | ✅ composer 的 pill 显示 DSH 后台任务（终端图标，运行中右下角叠转环）：只在有运行中/停止中的任务时显示，文字只写「后台」（数量在面板里），全部结束即隐藏；多个 pill 同屏时可左右滑动浏览（宿主的 pill 轨道 0.15.3 起可横向滚动），目标 / 团队 / 后台各按自身规则独立显示；点开看每个任务的明细（弹层里运行中且可停的任务行带停止按钮：不弹确认，停止中转圈、以推送为准，失败在行下显示原因） |
| 目标（goal）pill | — | ✅ composer 的 pill 显示 DSH 目标，文字与手机面板标题恒为「目标」，状态由图标表达（运行中右下角叠转环、完成绿色对勾），面板首行说出完整状态；点开看目标（带 DeepSeek 标志，点文本即可在小号输入框里编辑）、「第 N 轮 · 预算 M」、「正在：<当前任务>」与受阻原因，按钮暂停 / 继续 / 清除（清除二次确认）；目标完成后 pill 再显示一次（只读，只能清除，只有点开并关闭面板后才隐藏；不点开时发送新消息不会隐藏）；重开会话后自动续跑会停，pill 直接给出恢复入口 |
| 团队（Agent Team）pill | — | ✅ 有共享团队任务的会话，composer 多一颗「团队」pill（有队员在跑时人形图标右下角叠转环、团队记录出错时红色）；任务全部完成后只再显示一次，只有点开并关闭面板后才隐藏（不点开时发送新消息不会隐藏）；点开是只读面板：成员（队长、运行中 / 空闲 / 准备中 / 创建失败）和按状态分组的共享任务（进行中 / 可开始 / 等待依赖，已完成折叠），点任务看全文；`team_task_*` 工具结果画成字段卡，失败原因在中文环境翻成中文并保留原文 |
| 目标 / 工作流时间线 | — | ✅ `goal/change` 与 `tool-workflow/*` 事件按工具行渲染；目标自动续跑的每个轮次也各占一行（「目标续跑 · 第 N 轮」）；目标变化行叫「目标状态」，排在引起它的 `/goal` 命令之后；goal 工具结果画成字段卡，被拒调用给中文短句；后台工作流跨回合仍显示运行中 |
| 工具审批卡 | — | ✅ DSH 的 `approval/request` 转成 Paseo 审批卡（允许一次 / 拒绝） |
| 撤回（rewind） | — | ✅ 对话 + 文件都回退（消息行消失、被编辑工具改过的文件恢复、模型看不到被撤内容）；文件回退排除 >8 MiB 文件、符号链接目标与非普通文件；Paseo 0.15+ 时间线由宿主原生刷新，无需 Reload（0.15 真机待复验） |
| 会话用量 | — | ✅ 输入框旁显示 `已用 / 上限`，按会话上报（一个 `dsh` 进程服务多个 Paseo 会话时各算各的） |
| 会话级系统提示 | — | ✅ 每个会话可带独立的 system prompt（profile 需挂 `systemPrompt` 服务） |
| 终止后续聊 | — | ✅ 只取消当前回合，会话保留 |

## 🤖 复制这段给你的 AI Agent（推荐）

把下面整段复制进 Claude Code / Codex / Cursor / 任何能执行命令的 Agent。它会读文档、
探测你的模型、装好一切，**你只需要最后重启一次 Paseo**。

> 它需要读写 `~/.dsh/` 和 `~/.paseo/`、执行 shell 命令。给它这些权限，但**先自己扫一眼
> 下面的内容**——它做的事和你想让它做的事应该是一致的。

````text
你是一个部署助手，帮我把这台机器上的 Paseo 接上 DeepSeek Harness（DSH）。

仓库：https://github.com/bccy/paseo-dsh（这是本分支；npm 上的 paseo-dsh 是上游稳定线，不是这份代码）
先完整读一遍 docs/ADOPTION.md 再动手。不要凭猜测改任何文件。

■ 第一步：检查前提
确认 dsh、paseo、node 都在 PATH 上，paseo 版本 >= 0.16，dsh 版本 >= 0.2.1。
缺任何一样就停下来告诉我，不要替我安装它们。

■ 第二步：确定用哪个模型
先看我已经有没有 DSH profile：ls ~/.dsh/profiles/
如果已有，读它的 cordis.patch.yml，【复用我已经配好的 provider】
（baseURL、apiKeyEnv、模型 id），不要让我重新输一遍。
如果确实没有，再问我这三件事：
  1. LLM 端点 baseURL 是什么
  2. API key 放在哪个环境变量里（或者我直接给你 key）
  3. 要用哪些模型 id
拿到 key 后写进 ~/.dsh/.credentials.yaml：文件顶部写 version: 1，键值放在 refs 段下，
文件权限设成 600（DSH 拒绝别人可读的凭据文件）。
不要把 key 写进任何会被提交的文件，也不要在终端回显它。

■ 第三步：安装（从本分支的 GitHub 源装）
把 Paseo 会打印的那段「Plugins are trusted, unsandboxed code...」安全提示
【原文转述给我】，并明确问我是否继续。得到我同意之后再装：
  paseo plugin add github:bccy/paseo-dsh:paseo-plugin
（插件首次加载会自己准备好 DSH profile，不需要跑任何脚本。）
注意：npm 上的 paseo-dsh 是上游稳定线，装到的是上游代码、不含本分支功能，
不要用它代替上面这条。
装完重启 Paseo daemon。

■ 第四步：探测模型能力（关键，不许跳过）
先取插件目录：paseo plugin ls    # dsh-paseo 那行的 DIRECTORY 列，形如
                                  # ~/.paseo/plugins/dsh-paseo/<版本目录>/checkout/paseo-plugin
  node <插件目录>/bin/paseo-dsh.mjs probe --base-url <端点> --api-key-env <变量名> --model <模型id>
不要用 npx paseo-dsh：那会跑 npm 上的上游 CLI，不是本分支代码。
它输出的 YAML 片段【原样采用】。它会顺便告诉你两个必须处理的坑：
  - 如果 developer 角色被拒 -> 配置里必须有 compat.supportsDeveloperRole: false
  - reasoningEfforts 里的 off 必须留空（不写值）
  - 如果探测出 max，必须显式写进配置
如果探测工具报错，把完整错误贴给我，不要自己编一个配置。

■ 第五步：写配置
把第四步探测出的片段填进 ~/.dsh/profiles/paseo/cordis.patch.yml，
并补一段 agent-default-model 指向我选的主模型。
如果那个文件里已经有内容，只做补充，不要覆盖。

■ 第六步：验证（不许跳）
  node <插件目录>/bin/paseo-dsh.mjs doctor     # <插件目录> 同上：paseo plugin ls 的 DIRECTORY 列
（不要用 npx paseo-dsh doctor：它跑的是 npm 上游稳定线的 CLI，验的不是本分支。）
确认全绿（dsh/paseo 版本、profile、bridge、路由、key）。有问题就修，修完再跑一次。
然后重启 Paseo daemon。

■ 第七步：汇报
告诉我：
  - 需要重启什么（Paseo daemon）
  - 重启后我在 Paseo 里该选哪个 provider
  - 任何你没做到、或者不确定的地方

全程卡住就停下来问我。不要猜，不要跳过验证，不要为了让流程走完而伪造成功。
````

## 安装（推荐，一行）

本分支从 GitHub 源码安装——**这是唯一装到本分支代码的方式**：

```bash
paseo plugin add github:bccy/paseo-dsh:paseo-plugin
paseo plugin ls          # 确认 dsh-paseo 已装；DIRECTORY 列就是插件目录（后面自检要用）
```

> **npm 上的 `paseo-dsh`（最新 `0.2.17`）是上游稳定线**：装它拿到的是上游代码，
> **不含本分支的功能**。只有明确要上游稳定线时才用 `paseo plugin add npm:paseo-dsh`。
>
> 注意 `bccy/paseo-dsh`（**不带** `github:` 前缀）会被 Paseo 当成 **registry** 源；`--path`
> 是 `:plugin/path` 后缀的旧写法，对 registry 源会直接报错。

插件**首次加载会自己准备好 DSH profile**（默认 `~/.dsh/profiles/paseo`，用
`DSH_PASEO_PROFILE` 可改名——改了之后 daemon 也必须用同一个值）和内嵌的 stdio
bridge——不用 clone、不用跑脚本。更新只走 Paseo 这一条链路：`paseo plugin update`
（npm / Git 托管源都适用），然后重启 daemon，profile 会随插件一起更新。本地
`directory` 源（`install.sh`）则 `git pull` + 重启，见下节。

装完之后还差**一步：填模型路由**（这一步因人而异，没法自动）。分两小步：

### a) 告诉 DSH 去哪个端点、用哪些模型

编辑 `~/.dsh/profiles/paseo/cordis.patch.yml`。插件已生成一份带注释的模板，
**文件已存在时绝不覆盖**。一个完整例子（把 `my-gateway` / 端点 / 模型 id 换成你自己的）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:                       # 路由名，随便取，下面要一致
        displayName: My Gateway
        apiKeyEnv: MY_GATEWAY_API_KEY   # 指向 .credentials.yaml 里的键名（见 b）
        api: openai-completions
        baseURL: https://your-gateway/v1
        # 网关只认 system 角色、拒绝 developer 角色时必须加，否则每个回合 422
        compat:
          supportsDeveloperRole: false
        # 网关支持视觉才写；不写默认 [text]，图片会被换成占位文本
        defaultInput: [text, image]
        models:
          - id: your-model-id           # 端点上的模型 id
            name: your-model-id
            reasoningEfforts:           # 支持推理才写；不支持写 false
              off:                      # 留空 = 不发参数（多数网关拒绝字面量 "off"）
              low: low
              medium: medium
              high: high
              max: max                  # max/xhigh 必须显式列出，缺键=不支持
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: my-gateway
    model: your-model-id
```

### b) 放 API key

写进 `~/.dsh/.credentials.yaml`（**不要**写进任何会被提交的文件）：

```yaml
version: 1
refs:
  MY_GATEWAY_API_KEY: sk-xxxxxxxx
```

`version: 1` 不能省（没有它 DSH 按旧版扁平格式拒绝激活凭据服务），键名只能是
`[A-Za-z_][A-Za-z0-9_]*`。文件必须是仅属主可读——编辑器/`cat >` 新建的文件默认
0644，DSH 启动时会拒绝：

```bash
chmod 600 ~/.dsh/.credentials.yaml
```

### c) 自检 + 重启

```bash
# 插件目录 = `paseo plugin ls` 里 dsh-paseo 那行的 DIRECTORY 列
# （github 源装出来形如 ~/.paseo/plugins/dsh-paseo/<版本目录>/checkout/paseo-plugin）
node <插件目录>/bin/paseo-dsh.mjs doctor
```

它会检查 `dsh`/`paseo` 版本、profile 是否就绪、bridge 是否落地、路由是否填好、
`apiKeyEnv` 对应的 key 是否存在——缺什么直接告诉你（只读，不改任何东西）。全绿后
**重启 Paseo daemon**（`paseo daemon restart`），在 Paseo 里新建会话时选
**DeepSeek Harness** 这个 provider。

> 别用 `npx paseo-dsh`：它解析到 npm 上的**上游稳定线**包，验的不是本分支的代码。

> **不确定端点支不支持推理 / thinking 档位 / vision？** 用同一个 CLI 探测你的端点，
> 它会直接打过去、把上面 a) 那段填好吐给你（同样不需要 clone 仓库）：
>
> ```bash
> node <插件目录>/bin/paseo-dsh.mjs probe \
>   --base-url https://your-gateway/v1 \
>   --api-key-env MY_GATEWAY_API_KEY \
>   --model your-model-id
> ```
>
> 两个最容易卡住的点它会替你确认：网关拒绝 `developer` 角色 → 要加
> `compat.supportsDeveloperRole: false`；`off` 档位必须留空。

**完整走查与踩坑清单见 [docs/ADOPTION.md](docs/ADOPTION.md)。**

相关地址：本分支仓库 <https://github.com/bccy/paseo-dsh> · Issue
<https://github.com/bccy/paseo-dsh/issues> · npm 包（**上游稳定线**）
<https://www.npmjs.com/package/paseo-dsh> · 上游插件目录页
<https://paseo.cafe/plugins/dsh-paseo> · 上游讨论帖
<https://github.com/getpaseo/paseo/discussions/6375>

## 本地开发 / 离线安装

改本仓库代码时，用 `install.sh` 把 checkout 作为**目录源**接入：它会建好（或沿用）DSH
profile、注册插件。`dsh-bridge` 的符号链接只是给「插件还没加载」这段窗口用的：插件每次
加载都会把 profile 里的桥**整体替换**（先写暂存目录、逐文件回读校验后原子换上；失败时保留
旧代际）成 `paseo-plugin/server/bridge-assets.ts` 里的内嵌副本，所以运行时生效的永远是内嵌
资产，不是这个 checkout 目录。

```bash
git clone https://github.com/bccy/paseo-dsh && cd paseo-dsh
./install.sh --check     # 先看前提条件与将要使用的 profile，不做改动
./install.sh             # 创建/初始化 profile + 注册插件
```

> **改了 `dsh-bridge/` 必须重新生成内嵌桥**：`node paseo-plugin/scripts/generate-bridge-assets.mjs`
> （`npm publish` 的 `prepack` 也会跑），再重载插件 / 重启 daemon，否则插件自举用的还是旧桥。
> **只 `git pull` + 重启不会更新桥。**

`--profile NAME` 必须与 daemon 的 `DSH_PASEO_PROFILE` 一致——插件按该变量决定启动哪个
profile，install.sh 会拒绝不一致的用法。自定义 profile 这样跑，并把变量持久化进
`paseo.service`：

```bash
DSH_PASEO_PROFILE=dev ./install.sh --profile dev
# paseo.service: Environment=DSH_PASEO_PROFILE=dev
```

安装脚本不会覆盖你已有的模型配置，动到的每个文件都会先备份。

## 组成

```
paseo-dsh/
├── dsh-bridge/          # DSH 侧：stdio 桥接 bundle
│   ├── lib/index.js     #   插件入口：命令行、stdin 生命周期、提问桥接
│   ├── lib/transport.js #   自带 JSON-RPC 行传输（支持 server→client 请求）
│   ├── lib/server.js    #   会话/计划/思考档位/catalog 的实现
│   └── cordis.patch.yml #   bundle 补丁：往 dsh-base 上挂桥接与提问工具
├── paseo-plugin/        # Paseo 侧：provider 插件（direct provider 实现；同名 npm 包由上游发布）
│   ├── index.server.ts  #   registerProvider() + 首次加载时自举 DSH profile
│   ├── server/
│   │   ├── provider.ts  #   连接、catalog、会话生命周期、权限卡片
│   │   ├── session.ts   #   单会话：提问→卡片、计划、思考档位、用量
│   │   ├── dsh-process.ts # 一个连接共用的 dsh 子进程（cwd/路由/MCP 按会话下发）
│   │   ├── timeline.ts  #   DSH 会话事件 → Paseo 时间线
│   │   ├── bootstrap.ts #   自举：写 profile 文件 + 把内嵌 bridge 落盘
│   │   └── bridge-assets.ts # 生成物：bridge 的 base64 内嵌副本
│   ├── lib/             #   doctor（自检）/ probe（能力探测）
│   └── bin/paseo-dsh.mjs#   CLI：doctor / probe
├── tools/               # 探测工具的瘦启动器（实现在 paseo-plugin/lib 里）
├── templates/           # profile 配置模板（含必踩的坑的注释）
├── harness/             # 独立探针，不依赖 Paseo 即可验证桥接与插件
└── docs/                # 改造指南 + 实战缺陷记录
```

## 工作原理

```
模型调用 ask_user_question
   └─ dsh-tool-ask-user → ctx.userQuestions.ask()
        └─ dsh-bridge: ctx.on('user-questions/request')
             └─ transport.request('paseo/question')   ← server→client 请求
                  └─ paseo-plugin: session.permission (kind: 'question', input.questions[])
                       └─ Paseo 渲染一张卡片，步进式选完所有问题，一次提交
                  ← 返回 { behavior:'allow', updatedInput:{ answers: { <header>: "B" } } }
             ← 返回 { answers:[{id, selected:['canary']}] }
        ← 工具返回，模型继续
```

关键点：**DSH 官方两个自动化协议都没有「服务端主动问客户端」这条通道**——ACP 明确不
承载 elicitation，SDK 协议里传输层支持但服务端从不发送。所以桥接自带了传输层，
把这个能力补上。

一个 provider 连接的所有 Paseo 会话共用**一个** `dsh --profile <name>` 子进程，通过 stdio
上的换行分隔 JSON-RPC 通信。工作目录、模型路由、MCP server 都是**按会话**下发给这个进程的
（DSH 按 session 维护它们，运行时不需要 `chdir`），所以多个会话可以同时开在不同工作区；
省掉的是每次新建会话 1.5–2.7 s 的 CLI 冷启动。**环境变量是例外**——它是进程级的，只有首个
会话打开时的环境生效；后续会话要求不同的值时，差异以 warning 出现在时间线上（只列键名、
不列值），不静默忽略。**宿主按 agent 注入的三个身份键 `PASEO_AGENT_ID` /
`PASEO_AGENT_CWD` / `PASEO_WORKSPACE_ID` 不放进共享进程的 env**（进程级只能保留首会话的值，
错比没有更糟）：它们按会话传给桥，再由桥在每次执行时下发为 `DSH_PASEO_*`、经 `BASH_ENV`
映射回真名——**模型 bash 工具、后台任务和沙箱里的 `PASEO_*` 是本会话自己的值**；持久 shell、
侧栏终端和 `run_code` 的 `process.env` 里没有（DSH 在这些通道没有 per-session env 注入点）。
在没有身份的 shell 里调 Paseo CLI：`heartbeat` 报错，`agent send` 不带发件人且默认 interrupt，
`agent run` 建顶层 agent（未传 `--workspace` 时新建并打印 Tip）。详见 FIELD-NOTES #99。

## 重开会话后的回合折叠（已知问题）

仓库**不再提供宿主补丁**：原来 `local-patches/` 只做一件事——重放时补回丢失的 `turnId`，让
重开的长会话回合折叠正确。它改写**已安装的** `@getpaseo/server` 的 `dist`（上游没有对应扩展
点），从来不是发布产物（`npm publish` 出去的包里没有它），而且上游到 0.16.0-beta.1 仍未修
（`agent-manager.js:3461,3516`），所以这个缺陷以"已知问题"的形式留着，**等上游修**。

| 能力 | 现在的行为（无补丁） |
|---|---|
| **撤回**（对话 + 文件） | 撤回**已经生效**：对话、智能体改过的文件、模型上下文都回退了；时间线由宿主**立刻刷新**（Paseo 0.15.0 起，上游 PR #8368 修掉 #4667：撤回时关掉 provider 会话、带 persistence 重开并按 DSH 持久化会话重放），无需 Reload。canary「撤回已生效」仍在回执前发出，0.15+ 的 replay 会把它连同旧 history 清掉（看不到是预期；判据是消息行是否消失）。被编辑工具跟踪过的文件还会在每条人类消息边界重扫磁盘，bash/外部进程对它们的改动会保留在后续撤回的 pre-image 中 |
| **重开会话后的回合折叠** | **部分失效**：系统触发的回合会并入上一回合、插话回合被拆开（`turnId` 在重放时丢失）。等上游 [#8053](https://github.com/getpaseo/paseo/issues/8053) / PR [#8054](https://github.com/getpaseo/paseo/pull/8054)，0.16.0-beta.1 仍未修 |
| **子代理第二次派发时的「运行中」** | 卡片停在上一回合的终态。上游 [#8080](https://github.com/getpaseo/paseo/pull/8080) 已修复，Paseo 0.15.0 起生效 |

> 有两件事与补丁无关：记忆插件此前采集过的内容可能仍被召回（模型"记得"）；撤回本身不可撤销。
>
> canary 的可见性：live 投递一律看不到；Paseo 0.15.0+ 的 replay 会清掉它（预期）。依据是
> 0.15.0 的 `plugin-provider.js` 源码（`ensureReplay` / `replayBinding` 先 `clearBinding()`），
> **真机撤回未复验**；复验前不要删改 canary。

## 自测 / 本地验证（不需要 Paseo）

**先跑仓库里的 CLI 自检**（只读，不改任何东西；在 checkout 里直接跑，不要用 `npx`——
那是上游 npm 包）：

```bash
node paseo-plugin/bin/paseo-dsh.mjs doctor          # 安装完整性：CLI/版本/profile/bridge/路由/key
node paseo-plugin/bin/paseo-dsh.mjs probe --base-url <端点> --api-key-env <变量名> --model <模型id>   # 端点能力
```

> 从 github 源装到 Paseo 的插件带的是同一个 CLI：路径 = `paseo plugin ls` 的 DIRECTORY 列 +
> `/bin/paseo-dsh.mjs`。

**再对协议层做断言**（界面不可信，事件流才可信）：

```bash
node harness/catalog.mjs      # 列出 provider / 模型 / 每个模型真实支持的思考档位
node harness/probe.mjs        # 端到端跑一轮提问往返
node harness/route-test.mjs   # 逐个路由测试可用性

# 插件层检查（断言事件形状，不看界面）
cd paseo-plugin
npx tsc --noEmit false --outDir .dbg --declaration false \
  --module commonjs --moduleResolution node
# ↑ 在 --moduleResolution node 下会打印 @getpaseo/plugin/client 的 TS2307，属预期：
#   这里只要 emit 出的 JS，类型检查请用 `npx tsc --noEmit`
echo '{"type":"commonjs"}' > .dbg/package.json
cp ../harness/plugin-check.cjs .dbg/ && cd .dbg && node plugin-check.cjs
rm -rf ../.dbg
```

`plugin-check.cjs` 覆盖三件**曾经静默出错**的事：用量事件有没有真数字、非文本内容块
有没有被悄悄丢掉、未知输入是报失败还是谎报成功。这三类 bug 在界面上看不出来——
不报错，只是悄悄不对。

验证方法本身也值得一读——界面会乐观显示、会缓存、会骗你，所以断言要打在协议层。
[ADOPTION.md 第 5 节](docs/ADOPTION.md) 讲了具体做法，包括一些反直觉的坑
（比如 `waitFor` 会匹配到陈旧事件，导致误判）。

## 环境要求

- Paseo ≥ 0.16（0.16 把 composer 选项改成 `controls` / `providerOptions`，本插件已迁到新契约，不再支持 0.15）
- **DSH ≥ 0.2.1**（随 0.2.x 线）：桥直接 import 八个 DSH 内部包
  （`@deepseek-ai/dsh-cmdline` / `dsh-brand` / `dsh-llm` / `dsh-attachment` / `dsh-agent` /
  `dsh-tools` / `dsh-subprocess` / `schemastery`），并且 0.2.1 改过 prompt 变量注册与 catalog
  物化时机。实测通过的是 `0.2.1-rc.2`（2026-10-20）；**0.2.0 及更早未验证**，`doctor` 会把
  低于 0.2.1 判为 blocking。
- Node ≥ 20.4（20.x 线）：桥用了 `AbortSignal.any`（Node 20.3 起提供）与 `Symbol.dispose`
  （Node 20.4 起提供，`dsh-bridge/lib/session-projections.js`）。实际只在 Node 22.23.1 上验证过，
  20.4 本身未实测。插件本身跑在 Paseo daemon 的 Node 里，包**不**声明 `engines`——没有实测过的
  最小版本不写进声明。

## 界面语言（中文 / English）

composer 里的模式、思考档位、权限/预设下拉，以及 `/` 斜杠菜单、计划卡片，按 **daemon 环境**
的语言显示（`DSH_PASEO_LANG` / `LC_ALL` 等，**不是** Paseo App 自己的语言设置）。工具卡片
（含行标签）默认中文：服务端在每个 tool-call item 的 `metadata.locale` 上携带解析结果，客户端
收到第一个 tool-call 后才切换，且已渲染的行不会重绘——这是插件协议没有 locale 通道导致的
已知限制。**显示归显示，调用值不变**——切语言不会改动任何发给 DSH 的 id：

- 模式 `build` / `plan`、权限预设键（`read-only` / `workspace-write` / `danger-full-access`）、
  模型与思考档位 id、命令名字，全部原样传输。
- 斜杠命令**只翻译描述和参数提示，命令名保持英文**，菜单长这样：

  ```text
  /goal       设置或查看长任务的目标
  /compact    压缩较早的对话历史
  /permission 切换权限预设（沙箱模式 + 审批策略）
  ```

  参数提示里的控制词（`clear` / `pause` / `resume` / `edit` / `off`）也保持英文——那是命令
  真正接受的语法，不是文案。**没有任何中文会上线**：DSH 收到的、会话里回显的都是 `/goal`。

  为什么不连命令名一起翻译？Paseo 的 command 协议（`AgentSlashCommand`）只有 `name` /
  `description` / `argumentHint` / `kind`，**没有单独的显示名字段**——菜单显示什么、回传给
  插件的就是什么。翻译 `name` 会让中文名上线，而 DSH 自己的斜杠解析器只认
  `[a-z][a-z0-9_-]*`，只能再映射回去；不如让名字始终是原名。

- 技能（`/paseo`、`/paseo-help`、`/paseo-plugin` 这些）**只翻译菜单里的说明**，名字不动、
  模型读到的说明也不动（那份原文是模型判断"该不该用这个技能"的依据）。
  为什么要绕这一道、而不直接改技能文件：这些技能由 Paseo 托管——每个技能目录里有
  `.paseo-managed-files.json` 记着 `SKILL.md` 的哈希，Paseo 同步时只要内容不一致就重写，
  手改会被回滚。所以中文说明放在插件的 `SKILL_COPY` 表里（`server/locale.ts`），
  表里没有的技能保持原文。

语言按这个顺序决定（**这是服务端文案的口径；客户端 bundle 读不到 daemon 环境，默认 `zh-CN`**）：

1. 环境变量 `DSH_PASEO_LANG`——`zh` 开头 → 中文，其他 → English，显式覆盖一切；
2. daemon 自己的 `LC_ALL` / `LC_MESSAGES` / `LANG`——`zh` 开头 → 中文；
3. 都没有 → English。

所以中文系统上默认就是中文；英文系统上默认英文。要强制另一种语言，在**启动 daemon 的环境**
里设置（改完重启 daemon，环境变量在进程内不会变）：

```bash
DSH_PASEO_LANG=en paseo ...
```

菜单里出现词典没收录的命令（profile 多挂了一个命令插件、或 DSH 版本更新加了命令）时，那条
会保持原样显示，而不是消失——加中文只要在 `paseo-plugin/server/locale.ts` 的
`COMMAND_COPY` 里补一条。

## 权限模式（放开沙箱）

DSH 默认是 **`workspace-write`**：只能改会话工作目录内的文件，越界操作要审批。会话建好后，
Paseo composer 里有一个 **Permissions** 下拉，可随时切换预设（等价于 `/permission <preset>`）：

- `read-only` —— 只读，任何改动都问
- `workspace-write` —— 可改工作区（默认）
- `danger-full-access` —— 不限目录、不审批（**完全放权**，谨慎）

想让**所有新会话默认就完全访问**，在你的 profile `~/.dsh/profiles/paseo/cordis.patch.yml`
里加这两段（与模型路由并存）：

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
```

改回默认就把 `mode` 设回 `workspace-write`、`policy` 设回 `ask`。改完重启 daemon。

## 人设预设（Preset，可选）

DSH 的 agent preset 能把"人设 + 一套能力"打包成一个选项。插件**不强制**它——只有你的 profile
挂了 `@deepseek-ai/dsh-agent-preset-registry` 并声明了 preset，composer 里才会出现 **Preset** 下拉。

语义和 DSH 一致：**建会话时选，首个回合后锁定**（之后再改会被拒绝并弹回）。

启用示例（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
        selectedDefault: standard
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful assistant.
              # 注意：DSH 0.2.1 起只注册 provider/model 变量，{{cwd}} 会导致每回合失败
```

> 想让某个人设自带额外工具（例如挂一个领域工具插件），把它加进对应 preset 的 `plugins:` 即可——
> 插件对 preset 是"加法"：host 层的工具照常可用，preset 只负责人设与增量能力。
> 建议把 host `system-prompt` 的人设清空（`personaPrefix: ''`），改由各 preset 自带，避免重复。

## DSH 配置透传（第三方插件的简单开关）

装在 DSH profile 里的第三方插件，如果它的配置**整体只有一个布尔开关**（例如 `dsh-unrestricted`
的 `enabled`），Paseo 的会话配置菜单（模型 / Thinking / 模式 / 预设 / 权限那一组）会自动多出
一行**两选一的下拉**：标签取插件自己的显示名（插件包 locale 字典的 `meta.title`，按 Paseo 的
界面语言选，读不到就用包名），当前值直接从 DSH 运行时读取。桌面工具栏上这一行显示选中项文字
（如「关闭」），点开是「开启 / 关闭」两项——和「权限」「模式」两个选择器是同一种控件。装/卸
插件后重开一次会话，这一行就会出现/消失。

**为什么是下拉而不是 Paseo 的开关（toggle）控件**：宽布局下宿主把 toggle 画成无文字的图标按钮
（`packages/app/src/composer/agent-controls/index.tsx:1344` 的 `showToolbarLabel={false}`），
且 feature 不活跃、或 feature id 不在高亮表里时图标颜色恒为 muted（`index.tsx:214-239` 的
`getFeatureIconColor`；`utils.ts:42-46` 对 toggle 只认 `value`，`utils.ts:48-60` 未知 id 走
`default`）——开关状态没有任何视觉反馈，点了也看不出来。同一个 feature 用 `select` 投影时渲染成
「图标 + 选中项文字」并可点开菜单（`index.tsx:1360-1400`，选中项文字在 `:1379`），状态可见。
**只有宽布局直显**：宽布局走 `index.tsx:1092-1100` 的 else 分支逐个渲染 `DesktopFeatureItem`；
condensed/tight 密度会把所有 feature 收进一个 Settings2 面板
（`layout.ts:105-130` 决定 `aggregateFeatures`，`index.tsx:1060-1090` 画按钮与面板），面板里
同样是「label + 选中项」两行（`index.tsx:1501-1503`），所以两种密度下这个开关都有名字和状态。
**option label 就是纯「开启/关闭」（`On`/`Off`），不再拼开关名**：早先拼成「破限模式：开启」
时用户反馈与菜单/行里的名字重复；现在宽布局工具栏只显示这个词（开关名仍在行的 `label` 上，
hover tooltip 与 condensed/tight 面板行会显示），手机端设置行也不再出现重复名字。下拉的选项值
是 `on`/`off`（Paseo 持久化/回传的也是它）；**桥协议仍是 boolean**，插件在边界上转换，旧 agent
里持久化的 boolean 同样兼容。（行号取自本地 Paseo checkout 的 `packages/app` 0.15.0；0.16 的客户端
代码未逐行复核，形状以协议类型为准。）

**范围是刻意收窄的**：只显示第三方插件（模块名不以 `@deepseek-ai/` 开头、且是真正的包名——
`cordis:` 这类运行时 specifier 与相对路径都不算）、且整个 volatile 配置**恰好一个 boolean
字段**的项。官方内部开关、多字段表单、字典/枚举型配置都不显示——避免菜单里塞进几十行 DSH
部署参数。

**语义是全局的**：DSH 配置属于 profile（一个 `dsh` 子进程服务该连接的所有会话），所以这一行
不属于"某个 agent"——开关会同时影响本机所有 DSH 会话，切换后所有打开会话的菜单一起刷新。行的
描述文案写明了这一点。

**新建会话面板里的选择**：在创建面板选这个下拉时，值会随新 agent 一起传来（`on`/`off`；旧
agent 可能是 boolean），但**不会在打开时立刻写入**——宿主为了刷新创建面板本身也会打开一个临时
会话，打开即写就等于"刷新菜单改全局开关"。所以这个值先挂起，等该会话**第一次提问前**再写回；
写失败只在时间线上留一条 warning，不阻断提问；打开后没提问就关闭（草稿）则直接丢弃。重开会话
（resume）则相反：Paseo 记住的是"宿主以为的旧值"，与 DSH 运行时不一致时**以运行时为准，不写回、
不发时间线提示**，只在 daemon stderr 记一行——全局开关不该被一次重开悄悄覆盖。回传值会先归一化
成 boolean 再比较/写入（`on`/`off` 字符串与旧 boolean 都认）。非预期值分两条路处理：切换
（configure）时按协议错误响亮失败；open/resume 时无法识别的持久值会被忽略，但**每个被忽略的
值都记一行 daemon stderr**（不静默丢弃）。

实现路径：插件把桥返回的每个布尔项投影成 `ProviderSetting.select`（值 `on`/`off`，option
label 为「开启/关闭」），经桥的 `paseo/settings/list` 读 DSH 的
`settings.describe()`，切换经 `paseo/settings/set` 调 `settings.mutate()`（bridge 侧仍是
boolean）—— 值写进 profile 的 `cordis.patch.yml` 并由
configEditor 当场 reconcile，**不依赖 HMR**（Paseo profile 的 bridge bundle 显式关掉了 HMR）。
写入前置条件有两层：`revision`（settings 服务自己的乐观锁）之外还带 `expectedValue`（切换前
界面上显示的值）——两层锁防的是不同的 stale 状态，值对不上时桥直接返回 `conflict`，不调用
写入。桥订阅 DSH 的 `settings/document-updated`，外部改动（例如 DSH Web 界面的设置页）会以
`paseo/settings/changed` 通知插件，再刷新所有会话的菜单。**通知的触发条件**：该事件由 DSH
settings 在 `describe()` 时对比 revision 后发出；绕过 `settings.write` 的外部写入（例如直接手改
`cordis.patch.yml`）且之后没有任何人调用 `describe()` 时不会触发，菜单要等到下次打开/刷新会话
才更新。

**并发写**：同一个 `dsh` 进程内，settings 写入经 configEditor 的文件锁 + 写前 reconcile 串行；
两个 `dsh` 子进程共用同一个 profile 时是 last-writer-wins，`revision`/`expectedValue` 只防单进程
内的 stale 点击，跨进程不保证。

## 版本策略

插件的 `major.minor` **跟随它所适配的 DSH 线**：`0.2.x` 的插件对应 DSH `0.2.x`，
patch 位是插件自己的发布计数。装的时候挑与 daemon 上 `dsh` 同一条线的版本即可。

仓库里的版本号以 `paseo-plugin/package.json` 为**唯一来源**（本轮核对为 `0.2.16`）。npm 上
最新发布是 `0.2.17`（`npm view paseo-dsh version`，2026-10-30）——那是**上游稳定线**的版本：
npm 包 `paseo-dsh` 由上游维护，本分支没有该包的发布权，所以**本次不发布 npm**，本分支只走
github 源交付。安装时挑与 daemon 上 `dsh` 同一条线的版本即可。

## 更新日志

按 npm 发布顺序记录每个 patch 的**用户可见变化**。`0.2.x` 的 minor 跟随它所适配的 DSH 线，
patch 是本插件自己的发布计数。**下面的版本号和 npm 链接来自上游发布线**（npm 上的 `paseo-dsh`）；
本分支自己的改动看 [bccy 的 commits](https://github.com/bccy/paseo-dsh/commits/main)。

| 版本 | 日期 | 更新内容 |
| --- | --- | --- |
| [0.2.17](https://www.npmjs.com/package/paseo-dsh/v/0.2.17)（上游，本分支尚未合入） | 2026-10-30 | **统计行重新贴合页脚**：按页脚实际绘制的位置测量并贴齐，原生皮肤下「最新回合」和「被新回合顶下去」两种状态都稳定在约 4.5px 间距；字号统一为页脚同款 13px。量不到、找不到页脚或间距超出合理范围时退回宿主间距，native 不补偿；第三方主题的位置仍由主题自己控制。 |
| [0.2.16](https://www.npmjs.com/package/paseo-dsh/v/0.2.16) | 2026-10-29 | **统计行回到默认位置**：移除 0.2.15 里的自动贴靠、DOM 测量与设置页，只保留内容显示（轮/步、首字、tok/s、上下文、缓存命中，点开展开明细）。位置交还给 Paseo 和主题，不再随展开/收起或换主题移动。`0.2.15` 已标记 deprecated。 |
| [0.2.15](https://www.npmjs.com/package/paseo-dsh/v/0.2.15) | 2026-10-29 | **统计行贴合回合页脚**：统计行与「复制 / 模型 / 时间 / 耗时」页脚的间距在默认主题和主题插件下保持一致；回合完成时给最后一行打 `final`，web 端实测页脚的实际位置再贴齐，native 用常量回退。<br>**可配置**：Settings → Plugins →「回答统计行」可调间距（0–24px，默认 6）与字号（10–16px，默认 13）；未保存设置时行为与之前完全一致。<br>**字号与数字**：默认对齐页脚的 13px，数字等宽不跳动。 |
| [0.2.14](https://www.npmjs.com/package/paseo-dsh/v/0.2.14) | 2026-10-28 | **统计行更直观**：收起行里的会话总 tokens 换成上下文占用百分比（如 `上下文 77%`），精确的 `已用 / 上限` 仍在展开详情里；其余计数与缓存命中口径不变。 |
| [0.2.13](https://www.npmjs.com/package/paseo-dsh/v/0.2.13) | 2026-10-28 | **统计行信息升级**：收起时常驻 `N 轮 N 步 · 首字 · tok/s · 总 tokens · 缓存命中`，口径与 DSH Web 一致（总量 = 未缓存输入 + 缓存读取 + 缓存写入 + 输出；命中 = 缓存读取 ÷ 输入侧总量）；恢复会话时会从历史日志重新累计轮/步/tokens。点开仍是上下文、Tokens、路由、工具详情。 |
| [0.2.12](https://www.npmjs.com/package/paseo-dsh/v/0.2.12) | 2026-10-28 | **回答真流式**：改订阅 DSH 的 `agent/assistant-stream` 瞬时帧（文本 + 推理），边生成边显示，不再等整段生成完再回放；首字出现的时刻就是模型吐出第一个字的时刻。<br>**回答统计行**：回答下方显示 `首字 xxx · xx tok/s`，点开可看上下文占用、输入/缓存/输出 tokens、路由与思考档位、工具次数与耗时；速度用 DSH 自己的 chunk 时间戳计算，整段突发的异常值直接丢弃。 |
| [0.2.11](https://www.npmjs.com/package/paseo-dsh/v/0.2.11) | 2026-10-28 | **上下文用量**：输入框旁显示 `已用 / 上限`。bridge 新增 `paseo/usage`，占用取 DSH 的 `contextPressure`（无采样时用 `tokenMeter.measure()`），容量取当前路由的 `resolveModelInfo()`；会话打开/恢复、回合结束、切模型、压缩后刷新，恢复旧会话不用新回合就有数。本 fork 按会话上报（`usage(sessionId)`），一个 `dsh` 进程服务多个 Paseo 会话时各算各的。<br>**安装兼容 Paseo 0.9–0.11**：去掉 `@getpaseo/protocol` 的 type-only 导入（改成插件内 `json-value.ts`），旧版安装器不再因解析不到类型而失败。<br>**回答逐字出现**：上游用 `server/stream-replay.ts` 在 `assistant/message` 到达后按 `data.stream` 定时器重放；**本 fork 不采用**——桥直接订阅 DSH 的瞬时帧发 `paseo/assistant-delta`，本来就是真流式，两者叠加会双重流式，故该文件已删除。 |
| [0.2.10](https://www.npmjs.com/package/paseo-dsh/v/0.2.10) | 2026-10-27 | **附件不再拖垮会话**：`uploaded_file`、review、GitHub/forge 附件降级成文本引用（文件名 / 类型 / 大小 / 路径，或 title / url / body），模型仍能读到；内容块转换移进 `try`，单条消息失败不再升级成 `session.runtime_failed`。<br>**目录概览**：补 `OVERVIEW.md` 与包描述，paseo.sh 的插件页能正确介绍能力与限制。 |
| [0.2.9](https://www.npmjs.com/package/paseo-dsh/v/0.2.9) | 2026-10-17 | **模型选择器不再为空**：DSH 0.2.1 的 catalog 异步物化，而 Paseo 的 catalog 探测不走 `initialize`；现在先预热默认路由，再短暂轮询（约 3s），等模型注册完再返回。 |
| [0.2.8](https://www.npmjs.com/package/paseo-dsh/v/0.2.8) | 2026-10-17 | **修复 DSH 0.2.1 每回合失败**：0.2.1-rc 只注册 `provider` / `model` 两个提示词变量，persona 里的 `{{cwd}}` 会让整个回合报 `unknown prompt variable`；移除它，cwd 改由运行时上下文提供。 |
| [0.2.7](https://www.npmjs.com/package/paseo-dsh/v/0.2.7) | 2026-10-14 | **导入列表可区分了**：每行显示会话标题和首条真实用户消息预览；并发读取日志前缀，40 个会话也能在 1 秒内列完。 |
| [0.2.6](https://www.npmjs.com/package/paseo-dsh/v/0.2.6) | 2026-10-14 | **中文说明**：npm 包页与 paseo.cafe 插件页同时展示中英文描述。 |
| [0.2.5](https://www.npmjs.com/package/paseo-dsh/v/0.2.5) | 2026-10-14 | **重开会话回放历史**：bridge 新增 `paseo/sessions` / `paseo/history`，按 DSH session id 读取日志并回放真实用户回合与工具项。<br>**导入 DSH 原生会话**：声明 `session.list`，从 `~/.dsh/sessions` 列举并导入。 |
| [0.2.4](https://www.npmjs.com/package/paseo-dsh/v/0.2.4) | 2026-10-09 | **插件重载 / daemon 重启后可恢复会话**：补上 `session.persistence` handle（`plugin:` 前缀），并用 `ctx.get()` 访问未注入的 `sessions` 服务，修掉重开时的两个连续报错。 |
| [0.2.3](https://www.npmjs.com/package/paseo-dsh/v/0.2.3) | 2026-10-09 | **Preset 下拉**：profile 挂了 `agent-preset-registry` 时，composer 里可选人设 + 能力包；建会话时选、首回合后锁定。<br>**profile 更耐升级**：`package.json` / `cordis.yml` / `pnpm-workspace.yaml` 已存在时不再覆盖。 |
| [0.2.2](https://www.npmjs.com/package/paseo-dsh/v/0.2.2) | 2026-10-09 | **Permissions 下拉**：在 composer 里直接切 DSH 的沙箱预设（`read-only` / `workspace-write` / `danger-full-access`），等价于 `/permission <preset>`；bridge 新增 `paseo/permission`。 |
| [0.2.1](https://www.npmjs.com/package/paseo-dsh/v/0.2.1) | 2026-10-09 | **自带 CLI**：`npx paseo-dsh doctor` 只读检查 CLI / profile / bridge / 路由 / key；`npx paseo-dsh probe` 探测端点真实能力。装完不用 clone 就能自检和探模型。<br>安装走查补上完整的模型路由示例。 |
| [0.2.0](https://www.npmjs.com/package/paseo-dsh/v/0.2.0) | 2026-10-09 | **首个公开版本**：DSH 作为 Paseo 原生 provider（不是 ACP）；`ask_user_question` 原生提问卡片、Build / Plan 模式、按模型真实声明的思考档位、插话、图片端到端、`/` 命令与技能菜单；插件首载自举 DSH profile，`paseo plugin add npm:paseo-dsh` 一行安装。 |

> `0.1.x` 只在本地开发，未发布 npm；`0.0.0-stage` 是首次发布前的占位版本。

## 相关文档

- [docs/ADOPTION.md](docs/ADOPTION.md) — 改造指南：改动点、配置方法、踩坑清单
- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) — 七十余条真实缺陷的症状 → 根因 → 修法
- [docs/GOAL.md](docs/GOAL.md) — 目标（goal）在 Paseo 中怎么工作：数据源、pill 与按钮、
  运行中发消息、重开后的恢复
- [docs/REWIND.md](docs/REWIND.md) — 撤回：宿主侧行为、canary 顺序、0.15 原生刷新与降级行为
- [docs/TEAM.md](docs/TEAM.md) — 团队（Agent Team）：共享任务、成员状态、pill 的显示与隐藏规则
- [AGENTS.md](AGENTS.md) — 给 AI Agent 的说明（Codex 等会自动读取）。不管你是被叫来
  装它、还是被叫来改它，先看这个

## 联系

用的时候卡住了、发现文档写错了、或者你用它接上了别的运行时——都欢迎直接开 Issue：

**<https://github.com/bccy/paseo-dsh/issues>**

这是本分支唯一的联系入口（不提供邮件支持）。

## 许可

MIT。本分支继承自 [liuxing7954/paseo-dsh](https://github.com/liuxing7954/paseo-dsh)
（MIT，原作者 jixy），修改与新增部分由 bccy 维护并署名，见 [LICENSE](LICENSE)。
