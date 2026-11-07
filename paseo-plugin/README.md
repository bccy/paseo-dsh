# paseo-dsh

English · [中文](#中文说明)

DeepSeek Harness (`dsh`) as a **native** Paseo provider — not ACP.

This is the Paseo-side provider plugin of the **bccy/paseo-dsh** branch (inherited
from `liuxing7954/paseo-dsh`, MIT, original author jixy). Install it through
Paseo's own plugin installer from the GitHub source:

```bash
paseo plugin add github:bccy/paseo-dsh:paseo-plugin
```

> **The `paseo-dsh` on npm is the upstream stable line** (latest `0.2.17`): it is
> upstream code and does **not** carry this branch's features, so
> `paseo plugin add npm:paseo-dsh` is only for people who want that line.
> This branch has no npm publishing rights and publishes nothing itself.
>
> `bccy/paseo-dsh` without the `github:` prefix is a **registry** reference on
> Paseo >= 0.9 and fails; the legacy `--path` flag is the old spelling of the
> `:plugin/path` suffix.

On load it provisions `$DSH_HOME/profiles/paseo` (the DSH profile it drives; set
`DSH_PASEO_PROFILE` to use another name — the daemon must use the same value),
including the stdio bridge bundle it carries — no shell script, no manual
profile setup. The only thing left is your model route in
`~/.dsh/profiles/paseo/cordis.patch.yml`.

The plugin ships a small CLI for that setup. It runs **from the installed plugin
directory** (the `DIRECTORY` column of `paseo plugin ls`, plus `/bin/paseo-dsh.mjs`),
or from a checkout as `node paseo-plugin/bin/paseo-dsh.mjs`:

```bash
node <plugin-dir>/bin/paseo-dsh.mjs doctor   # check CLIs, profile, bridge, model route and credentials
node <plugin-dir>/bin/paseo-dsh.mjs probe --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV --model your-model-id   # discover reasoning levels etc.
```

Do not use `npx paseo-dsh`: that resolves to the upstream npm package, not this branch.

What you get that the ACP boundary can't carry:

- `ask_user_question` → real Paseo question cards
- Build / Plan mode, with the plan shown before approval
- Thinking effort rendered from each model's actually-declared levels
- Steer into the running turn
- Images admitted into DSH's attachment store, delivered per the route's modality
- A `/` menu with DSH's registered commands **and** user-invocable skills
- A **Permissions** select in the composer that switches DSH's sandbox preset
  (read-only / workspace-write / danger-full-access)
- A **Preset** select when the profile declares agent presets — DSH's
  persona+capability bundles, chosen at session start and locked once it begins
- Session **reopen and import**: a reopened session replays its conversation
  history, and native DSH sessions can be imported from Paseo
- Background **jobs** pill (visible only while something runs; steps aside while the goal and team pills are both visible, expandable)
- **Goal** and **workflow** rows in the timeline, including workflows that keep
  running across turns
- **Tool approval cards** for DSH's `approval/request`
- **Rewind** — the conversation and files both roll back (the message row
  disappears, files touched by edit tools are restored, the model no longer sees
  the withdrawn content); on Paseo 0.15+ the host refreshes the timeline
  natively, no Reload needed
- **Session usage** — `used / limit` next to the composer, reported per session
  (each session keeps its own numbers while one `dsh` process serves several
  Paseo sessions)
- A session-level **system prompt** when the profile mounts the `systemPrompt`
  service

Full documentation, the adoption guide, and 70+ real defects with their fixes
live in the main repository: **https://github.com/bccy/paseo-dsh**

Requires Paseo ≥ 0.9.2, **DSH ≥ 0.2.1**, **Node.js ≥ 20.4** (the bridge uses
`AbortSignal.any` and `Symbol.dispose`) and the official `dsh` on the daemon's
`PATH`. The bridge imports eight DSH-internal packages (`dsh-cmdline`,
`dsh-brand`, `dsh-llm`, `dsh-attachment`, `dsh-agent`, `dsh-tools`,
`dsh-subprocess`, `schemastery`); `0.2.1-rc.2` is the verified build and 0.2.0
and older are unverified (doctor fails them).

## Versioning

`major.minor` tracks the DSH line this plugin targets — `0.2.x` of this plugin is
built against DSH `0.2.x`. The patch number is this plugin's own release count and
does not follow DSH. Install the line matching the `dsh` on your daemon.

MIT. This branch (`bccy/paseo-dsh`) is inherited from
`liuxing7954/paseo-dsh` (MIT, original author jixy); modifications and additions
are credited to bccy, see [LICENSE](LICENSE).

---

## 中文说明

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）作为
Paseo 的**原生** provider 接入——**不是 ACP**。

这是 **bccy/paseo-dsh** 分支的 Paseo 侧 provider 插件（继承 `liuxing7954/paseo-dsh`，
MIT，原作者 jixy）。用 Paseo 自带的插件安装器从 GitHub 源安装：

```bash
paseo plugin add github:bccy/paseo-dsh:paseo-plugin
```

> **npm 上的 `paseo-dsh` 是上游稳定线**（最新 `0.2.17`）：装到的是上游代码，
> **不含本分支功能**，只有明确要上游稳定线时才用 `paseo plugin add npm:paseo-dsh`。
> 本分支没有 npm 发布权，不发布任何东西。
>
> `bccy/paseo-dsh` 不带 `github:` 前缀时在 Paseo >= 0.9 会被当成 **registry** 引用而失败；
> 旧的 `--path` 写法是 `:plugin/path` 后缀的旧拼法。

插件**首次加载会自己准备好** `$DSH_HOME/profiles/paseo`（它驱动的 DSH profile；可用
`DSH_PASEO_PROFILE` 改名——daemon 必须用同一个值），并把内嵌的
stdio bridge 落盘——不用 clone、不用跑脚本、不用手动配 profile。你只需要在
`~/.dsh/profiles/paseo/cordis.patch.yml` 里填自己的模型路由。

插件带一个小 CLI。它**从已安装的插件目录**运行（`paseo plugin ls` 的 `DIRECTORY` 列 +
`/bin/paseo-dsh.mjs`），也可以在有 checkout 时用 `node paseo-plugin/bin/paseo-dsh.mjs`：

```bash
node <插件目录>/bin/paseo-dsh.mjs doctor   # 自检：CLI / profile / bridge / 模型路由 / 凭证
node <插件目录>/bin/paseo-dsh.mjs probe --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV --model your-model-id   # 探测端点支持的推理档位等
```

不要用 `npx paseo-dsh`：它解析到 npm 上的上游包，不是本分支。

ACP 承载不了、而这里都有：

- `ask_user_question` → Paseo 原生提问卡片
- Build / Plan 模式，计划先展示再审批
- 思考档位按每个模型**真实声明**的档位渲染
- 插话（steer）注入当前回合，而不是排到下一个
- 图片入库后按路由模态投递
- `/` 菜单：列出 DSH 注册命令 **+** 用户可调用技能
- composer 里的 **Permissions** 下拉：切换 DSH 沙箱预设
  （read-only / workspace-write / danger-full-access）
- profile 声明了 agent preset 时的 **Preset** 下拉——人设 + 能力包，
  建会话时选、首个回合后锁定
- **会话恢复与导入**：重开会话会回放历史；并可从 Paseo 导入 DSH 原生会话
- 后台任务 **jobs** pill（仅在有 live 任务时显示，全部结束即隐藏；同一 agent 的目标与团队 pill 同时显示时让位隐藏，任一消失后若自身规则应显示则立即恢复，点开展开）
- 时间线里的 **Goal** 与 **workflow** 行，跨回合运行的工作流保持运行中
- DSH `approval/request` 的**工具审批卡**
- **撤回**：对话 + 文件都回退（消息行消失、被编辑工具改过的文件恢复、模型看不到被撤内容）；Paseo 0.15+ 时间线由宿主原生刷新，无需 Reload
- **会话用量**：输入框旁显示 `已用 / 上限`，按会话上报（一个 `dsh` 进程服务多个 Paseo 会话时各算各的）
- profile 挂了 `systemPrompt` 服务时，支持**会话级 system prompt**

完整文档、改造指南、以及 70+ 个真实缺陷的修复记录都在主仓库：
**https://github.com/bccy/paseo-dsh**

需要 Paseo ≥ 0.9.2、**DSH ≥ 0.2.1**、**Node.js ≥ 20.4**（桥用了 `AbortSignal.any` 与
`Symbol.dispose`），且 daemon 的 `PATH` 上有官方 `dsh`。桥直接 import
八个 DSH 内部包（`dsh-cmdline` / `dsh-brand` / `dsh-llm` / `dsh-attachment` / `dsh-agent` /
`dsh-tools` / `dsh-subprocess` / `schemastery`）；`0.2.1-rc.2` 是实测通过的版本，0.2.0 及
更早未验证（`doctor` 会判 blocking）。

### 版本策略

`major.minor` 跟随所适配的 DSH 线——本插件 `0.2.x` 对应 DSH `0.2.x`；patch 位是本插件
自己的发布计数，不跟随 DSH。装的时候挑与 daemon 上 `dsh` 同一条线的版本即可。

版本号来自上游发布线（npm 上的 `paseo-dsh` 由上游维护）；本分支不走 npm，改动见
[bccy 的 commits](https://github.com/bccy/paseo-dsh/commits/main)。

MIT。本分支（`bccy/paseo-dsh`）继承自 `liuxing7954/paseo-dsh`（MIT，原作者 jixy），
修改与新增部分署名 bccy，见 [LICENSE](LICENSE)。
