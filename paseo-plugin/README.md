# paseo-dsh

English · [中文](#中文说明)

DeepSeek Harness (`dsh`) as a **native** Paseo provider — not ACP.

This npm package is the Paseo-side provider plugin. Install it through Paseo's
own plugin installer:

```bash
paseo plugin add npm:paseo-dsh
# or from a checkout (Paseo >= 0.9.2 requires the explicit github: prefix and
# the :plugin/path suffix; the legacy `--path` flag and a bare `owner/slug` are
# a registry reference on Paseo >= 0.9 and fail):
paseo plugin add github:liuxing7954/paseo-dsh:paseo-plugin
```

> **Version note (2026-10-20):** the newest npm release is `0.2.9`
> (2026-10-17), which predates the Paseo 0.12 adapter. On Paseo 0.12 install
> from the repository command above (or wait for `0.2.10`). The npm line stays
> the simplest path for Paseo <= 0.11.

On load it provisions `$DSH_HOME/profiles/paseo` (the DSH profile it drives; set
`DSH_PASEO_PROFILE` to use another name — the daemon must use the same value),
including the stdio bridge bundle it carries — no shell script, no manual
profile setup. The only thing left is your model route in
`~/.dsh/profiles/paseo/cordis.patch.yml`.

This package also ships a small CLI for that setup:

```bash
npx paseo-dsh doctor   # check CLIs, profile, bridge, model route and credentials
npx paseo-dsh probe --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV --model your-model-id   # discover reasoning levels etc.
```

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

Full documentation, the adoption guide, and 60+ real defects with their fixes
live in the main repository: **https://github.com/liuxing7954/paseo-dsh**

Requires Paseo ≥ 0.9.2, **DSH ≥ 0.2.1** and the official `dsh` on the daemon's
`PATH`. The bridge imports five DSH-internal packages (`dsh-cmdline`,
`dsh-brand`, `dsh-llm`, `dsh-attachment`, `dsh-agent`); `0.2.1-rc.2` is the
verified build and 0.2.0 and older are unverified (doctor fails them).

## Versioning

`major.minor` tracks the DSH line this plugin targets — `0.2.x` of this plugin is
built against DSH `0.2.x`. The patch number is this plugin's own release count and
does not follow DSH. Install the line matching the `dsh` on your daemon.

MIT.

---

## 中文说明

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）作为
Paseo 的**原生** provider 接入——**不是 ACP**。

本 npm 包是 Paseo 侧的 provider 插件，用 Paseo 自带的插件安装器安装：

```bash
paseo plugin add npm:paseo-dsh
# 或从仓库（Paseo >= 0.9.2 必须带 github: 前缀和 :plugin/path 后缀；
# 旧的 --path 写法与裸 owner/slug 在 >= 0.9 会被当成 registry 引用而失败）：
paseo plugin add github:liuxing7954/paseo-dsh:paseo-plugin
```

> **版本提醒（2026-10-20）**：npm 上最新是 `0.2.9`（2026-10-17），不含 Paseo 0.12
> 适配。在 Paseo 0.12 上用上面的仓库命令装（或等 `0.2.10`）；Paseo ≤0.11 用 npm 最省事。

插件**首次加载会自己准备好** `$DSH_HOME/profiles/paseo`（它驱动的 DSH profile；可用
`DSH_PASEO_PROFILE` 改名——daemon 必须用同一个值），并把内嵌的
stdio bridge 落盘——不用 clone、不用跑脚本、不用手动配 profile。你只需要在
`~/.dsh/profiles/paseo/cordis.patch.yml` 里填自己的模型路由。

本包还带一个小 CLI：

```bash
npx paseo-dsh doctor   # 自检：CLI / profile / bridge / 模型路由 / 凭证
npx paseo-dsh probe --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV --model your-model-id   # 探测端点支持的推理档位等
```

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

完整文档、改造指南、以及 60+ 个真实缺陷的修复记录都在主仓库：
**https://github.com/liuxing7954/paseo-dsh**

需要 Paseo ≥ 0.9.2、**DSH ≥ 0.2.1**，且 daemon 的 `PATH` 上有官方 `dsh`。桥直接 import
五个 DSH 内部包（`dsh-cmdline` / `dsh-brand` / `dsh-llm` / `dsh-attachment` / `dsh-agent`）；
`0.2.1-rc.2` 是实测通过的版本，0.2.0 及更早未验证（`doctor` 会判 blocking）。

### 版本策略

`major.minor` 跟随所适配的 DSH 线——本插件 `0.2.x` 对应 DSH `0.2.x`；patch 位是本插件
自己的发布计数，不跟随 DSH。装的时候挑与 daemon 上 `dsh` 同一条线的版本即可。

MIT。
