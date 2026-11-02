# 安装交付层审查（doctor / probe / bin / scripts / manifest / install.sh / CI）

- 审查基线：`2f71225`（main，工作区干净；仅本报告所在目录为新增未跟踪文件）
- 上轮全量基线：`9298c28`（见 `docs/FULL-AUDIT-20261031.md` 的 D1/D2、CI 与版本声明结论）
- 环境：DSH 0.2.1-rc.5、Paseo 0.14.0、Node v22.23.1
- 方法：逐行读审 + 沙箱 `DSH_HOME` 驱动真实 `runDoctor()`/CLI + loopback 假网关驱动真实 probe；未写真实 `~/.dsh` profile、未跑真实模型回合、未安装依赖、未改任何生产代码
- 范围内文件：`paseo-plugin/lib/doctor.mjs`(529)、`lib/probe-provider.mjs`(372)、`bin/paseo-dsh.mjs`(57)、`scripts/generate-bridge-assets.mjs`(95)、`package.json`、`paseo-plugin.json`、`index.server.ts`(51)、`index.client.tsx`(209，入口装配粗看)、`tsconfig.json`、`.github/workflows/sync-upstream.yml`(131)、`install.sh`(266)、`tools/`

## 1. 结论

**交付层能用，但"自检"和"探测"两个核心判定仍会给出错误结论。** 上轮 D1（doctor 的 YAML 语义校验仍按 regex、六类无效配置全绿）与 D2（probe 把 baseline 之后的 401/402/403 鉴权/额度故障当成能力拒绝并 exit 0）在当前 HEAD 均**未修复**，本轮分别用 7 组沙箱配置与 3 个 loopback 状态码复现，并各自发现了原报告未列的形状（doctor 还放过"路由引用了未定义 provider"；probe 的伪造结论会同时写进 `profile fragment` 的建议）。发布产物、依赖与 lock、内嵌桥资产、TypeScript 与两条现有离线回归本身是健康的（43 个发布文件、21 个 bridge 文件、tsc exit 0、doctor-check 29/29、probe-check 21/21）；CI 有一处**本轮新引入**的冲突处理清单漂移。无 P0/P1，无阻断性健康问题；但按 AGENTS.md「doctor 全绿不算数」的口径，这一层今天仍然支持不了"全绿=可安装"。

## 2. 发现

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| DLV-01 | **P2** | `paseo-plugin/lib/doctor.mjs:442-450`（解析结果丢弃）、`:455-479`（路由 regex 扫描到 EOF）、`:481-510`（refs regex 扫描到 EOF） | 编辑 `cordis.patch.yml` / `.credentials.yaml` 后跑 `paseo-dsh doctor`。以下 7 类均输出 `All checks passed`、exit 0：①`provider: ""`/`model: ""`（解析后是空串）；②`agent-default-model.config` 为空、后续无关条目带 `provider:`/`model:`（doctor 还把无关值显示成 `default:`）；③`refs.AUDIT_KEY: ""`；④`refs.AUDIT_KEY: # no value`；⑤`refs:` 已结束后另一顶层区块同名 key；⑥`agent-default-model` 条目 `disabled: true`；⑦路由 `provider:` 指向 `providers:` 中不存在的名字。`providers:` 检查只是全文件找一行。阴性对照（`provider:` 真缺值）仍能 fail，说明不是"只会绿"。 | **实测**：/tmp 沙箱 DSH_HOME + 真实 CLI，7/7 假绿，正/负对照各 1 通过。代码同时证明 YAML parse 只用于语法（`:442-450`），语义仍按原文 regex | 基线已有（上轮 D1，未修复；⑦为本次新增的同类形状） |
| DLV-02 | **P2** | `paseo-plugin/lib/probe-provider.mjs:144-148`（`isVerdict` 只看状态码区间）、`:200-210`（developer role）、`:213-227`、`:313-349`（建议文案）、`:353-359`（exit 逻辑） | baseline 请求先成功，随后 gateway 返回 401/402/403（key 失效、额度耗尽、权限/路由策略拒绝）。probe 把 developer role 判为 `REJECTED -> needs compat.supportsDeveloperRole: false`，把 6 个档位全判 `rejected`，打印"declare `reasoningEfforts: false`"建议并 **exit 0**。用户按建议改 profile 后，临时鉴权故障就被固化成"该路由不支持思考/developer role"的永久降级。对照：429 判 unknown、exit 1；400 明确参数拒绝判 rejected、exit 0（均正确）。 | **实测**：loopback 假网关，401/402/403 三组均 exit 0 且给出两条错误建议；429/400 对照符合预期 | 基线已有（上轮 D2，未修复） |
| DLV-03 | P3 | `harness/doctor-check.mjs:197-208`、`harness/probe-check.mjs:114-127`、`:141-164` | 现有回归恰好绕开 D1/D2：doctor-check 的"完整配置"正对照把 `providers:` 挂在 `agent-default-model` 的 `config` 下，而真实模板/DSH schema 是 `llm-pi-ai.config.providers` + `agent-default-model.config.{provider,model,reasoningEffort}`（已装 rc.5 的 `dsh-agent-default-model` Config 只有这三个键），即正对照本身不是真实配置；probe-check 的 401 只用在 **baseline 就失败**的位置（只验证不泄 key），没有任何"baseline 200 之后 401/402/403"用例。 | **实测**：两条 harness 均 29/29、21/21 全绿；读用例确认覆盖缺口。DSH schema 来自已装包源码（`dsh-agent-default-model/lib/index.js` Config） | 基线已有（上轮 D1 的验收建议已点名，未落地） |
| DLV-04 | P3 | `paseo-plugin/lib/doctor.mjs:400-416`（只 `existsSync`）、`paseo-plugin/server/bootstrap.ts:128-137`（先 `rmSync` 再逐文件 `writeFileSync`） | 插件 provision 过程中进程被杀/磁盘写满，留下**零字节或截断**的 bridge 文件；文件存在但内容不完整，doctor 仍报 `bridge bundle provisioned (N files)`。doctor-check 的正对照本身就是用 `writeFileSync(target, "")` 生成 21 个空文件并通过（`harness/doctor-check.mjs:220-224`），证明"存在即完整"。 | **实测**（空文件正对照通过）+ **源码依据**（bootstrap 非原子写入）。对 DSH 是否必现加载失败为推断：空 `lib/index.js` 不可能导出桥入口 | 基线已有（`830b26b` 修复了"缺文件"未覆盖"坏文件"） |
| DLV-05 | P3 | `paseo-plugin/lib/doctor.mjs:295`、`install.sh:55-57`；正确基准 `paseo-plugin/server/bootstrap.ts:77-82` | DSH 支持 `DSH_HOME=~/x`、空/空白视为未设置并 `resolve()`；bootstrap 已按此实现，但 doctor 用 `process.env.DSH_HOME ?? join(homedir(),".dsh")`、install.sh 用 `${DSH_HOME:-$HOME/.dsh}`。触发：`DSH_HOME=~/alt` 时真实 profile 在 `$HOME/alt/profiles/<p>`，doctor 却检查字面 `~/alt/profiles/<p>` → `[fail] DSH profile missing`、exit 1（实测）；install.sh 则在当前目录创建字面 `./~/alt/profiles/paseo`，而 `$HOME/alt` 下没有 profile（实测 exit 0）。`DSH_HOME=""` 同理会让 doctor 相对 cwd 找 `profiles/`。 | **实测**（两处均复现）+ 源码对照 | 基线已有（上轮 E5 的一部分，未修复） |
| DLV-06 | P3 | `paseo-plugin/lib/doctor.mjs:142-154`（`compareCore` 只比三段）、`:313-332` | DSH 升到同 `major.minor` 的破坏性预发布（如 `0.2.2-alpha.2`，AGENTS.md 明确说它改了 model-selection 语义）时 doctor 报 `[ok]`；升到 `0.3.0-alpha.1`/`1.0.0` 只给 `[warn]` 且 exit 0（`pluginMM` 只比 `major.minor`）。即"doctor 永远不会拦住破坏性版本"这一文档声明在当前 HEAD 仍成立。 | **实测**：假 dsh 输出 0.2.2-alpha.2 → `[ok]` exit 0；0.3.0-alpha.1/1.0.0 → `[warn]` exit 0；0.2.0 → fail | 基线已有（AGENTS.md 已声明的已知限制） |
| DLV-07 | P3 | `paseo-plugin/lib/probe-provider.mjs:59-79` vs `:256-261` | 用户用 `--model=<id>`（parseArgs 明确支持 `=` 形式）时，models 收集循环只认空格形式，models 为空 → 报 `at least one --model is required`、exit 2。`--base-url=`/`--api-key-env=` 可用，同一条命令行里两种写法行为不一致。 | **实测**：`--model=m` → exit 2 + 该报错 | 基线已有 |
| DLV-08 | P3 | `paseo-plugin/lib/probe-provider.mjs:88-98`（`redactUrl` 只清 userinfo）、`:290-291`（`${baseUrl}/chat/completions` 字符串拼接） | 网关把凭据放在 base URL 的 query（如 `https://gw/v1?token=...`，Azure 类或自建网关常见）时：①`endpoint:` 行原样打印 query（`redactUrl` 只清 username/password），而 stdout 会被安装 agent 粘贴进对话；②把 `/chat/completions` 拼到 query 后面，实际请求路径变成 `/v1?token=.../chat/completions`，探测必然失败。 | **实测**：`token=AUDIT_QUERY_TOKEN_CANARY` 回显在 stdout，request path 为 `/v1?token=.../chat/completions` | 基线已有（上轮只覆盖了 Authorization 回显） |
| DLV-09 | P3 | `tools/probe-provider.mjs:15-16`；对照 `paseo-plugin/bin/paseo-dsh.mjs:36-39`、`paseo-plugin/lib/probe-provider.mjs:362-371` | 按 install.sh/README 用 `node tools/probe-provider.mjs ... \| head -1` 时，启动器自身没有 EPIPE 监听（lib 的直接运行分支和 bin 都有），head 关闭管道后抛 `Error: write EPIPE` 未捕获、exit 1 并打 stack。 | **实测**：`tools` 启动器 `\| head -1` → `PIPE=1` + unhandled EPIPE；同参数经 lib 直接运行 → `PIPE=0` | 基线已有（上轮未列） |
| DLV-10 | P3 | `install.sh:216-226` | 重跑 install.sh 时无条件 `config.pluginsEnabled = true`，并把 `config.plugins['dsh-paseo']` 整体覆写为 `{source:'directory', path}`。真实 Paseo 0.14 的条目是 `{source,path,enabled}`（本机 `~/.paseo/config.json` 实测形状），且服务端判定 `enabled !== false` 即启用。触发：用户曾全局关闭插件、或单独 `enabled:false` 禁用 dsh-paseo，再跑 install.sh（--yes 也直接过）→ 所有已配置插件随下次重启被重新启用。install.sh 是 AGENTS.md 里"非必需/旧式"路径，但这仍是静默改变安全状态。 | **实测**（真实配置形状）+ **源码依据**（install.sh 与 Paseo server `plugins/index.js:140`）；未对真实 Paseo 跑 re-enable 复现 | 基线已有（上轮 E5 提到覆写 config，未点 enabled/全局开关） |
| DLV-11 | P3 | `install.sh:73-107` | `--check` 只检查 `dsh`/`node`/`paseo` 可执行文件存在，不校验最低版本：用 `dsh 0.1.0` + `paseo 0.8.0` 的 stub 仍打印 `all prerequisites present` 并 exit 0；同一段还写 `a real install would write the model route to ...`，而真实安装只写"未配置"的模板（题头 `[]`）。doctor 里已有 `MINIMUM_DSH`/`MINIMUM_PASEO`，未复用。 | **实测**（旧版本 stub 下 exit 0；模板内容确认） | 基线已有 |
| DLV-12 | P3（**本轮新引入**） | `.github/workflows/sync-upstream.yml:110-119`（冲突 PR 手动清单）vs `:60-90`（自动门） | 自动合并成功时的门包含 `rewind-merge-check`、`mcp-http-check`、`doctor-check`、`probe-check`；冲突时生成给人工的清单注释写"其余离线回归与 CI 的门保持一致"，实际漏了这 4 个（基线版本的手动清单是完整的，HEAD 加新门时把那行替换掉、顺带挤掉了它们）。人工按提示解决冲突后可能漏跑 4 个门。 | **源码依据**（逐行比对；`git show 9298c28:.github/workflows/sync-upstream.yml` 对照） | **新引入**（HEAD 的 8 行 diff） |
| DLV-13 | P3 | `.github/workflows/sync-upstream.yml:8-12`、`:51-54` | 唯一 workflow 只由 `schedule`/`workflow_dispatch` 触发：普通 push/PR 没有任何 CI；且 upstream 已是 ancestor 时直接 exit 0、不跑任何门。普通提交的交付层改动（如本轮 doctor/probe）不会被自动门覆盖。上轮 E1 已提，HEAD 未变。 | **源码依据**（workflow 配置） | 基线已有 |
| DLV-14 | P3 | `paseo-plugin/package.json:39-42` vs `:25-38` | `prepack` 指向 `scripts/generate-bridge-assets.mjs`，但 `files` 不包含 `scripts/`：在已安装副本里执行 `npm pack`/`npm publish`（如二次分发、部分插件工具链）会 ENOENT。正常 `npm publish`（源码树内）与安装不受影响；git/npm 安装用的是已提交的 `bridge-assets.ts`。 | 推断（读 package.json 与 npm 生命周期；未在安装副本上复跑 pack） | 基线已有 |
| DLV-15 | P3 | `paseo-plugin/package.json`（无 `engines`）、`paseo-plugin/lib/probe-provider.mjs:155-160` | `npx paseo-dsh probe` 依赖全局 `fetch`（Node >=18）与 `AbortSignal.timeout`（>=17.3），package 未声明 `engines`：老 Node 上不是可读错误，而是 `ReferenceError`/`TypeError` 直接崩栈。`doctor` 主要用内置模块，受影响较小。 | 推断（源码 + 无 engines 字段；未在 Node 16 上跑） | 基线已有 |
| DLV-16 | P3 | `paseo-plugin/lib/doctor.mjs:77-86`（`execFileSync` 无 timeout）、`:344-359`（`paseo plugin ls` 文本匹配） | ①daemon 未运行/无权限时 `paseo plugin ls` 失败 → 只报 `[warn] could not list Paseo plugins`，其余静态检查通过 → **exit 0 "1 warning(s) — nothing blocking"**（实测），与 doctor 自己对 "we could not check ≠ fine" 的 fail-closed 标准不一致；②`execFileSync` 无 timeout，daemon 卡死时 doctor 无界等待；③行匹配依赖 `paseo plugin ls` 的文本格式（已用真实 0.14.0 输出验证当前兼容，但无版本矩阵）。 | **实测**（daemon-down 沙箱复现 exit 0）+ 源码 | 基线已有 |
| DLV-17 | P3 | `paseo-plugin/package.json:44-51`、`paseo-plugin/paseo-plugin.json:4-6` | 声明 `@getpaseo/plugin >=0.9.2` / `requirements.paseo >=0.9.2`。本轮把插件使用的全部宿主 SDK 符号对 0.9.2 tarball 做了类型面核对（`defineRpc`、`client.rpc`、`addComposerPill`、`PluginButtonRegistration`、`PluginServerContext.handle`、各 `Provider*` 类型等 30+ 个，0 缺失），static 上不支持"最低版本写太低"；但 CI/本机只装 0.14.0，0.9.2–0.13 的运行时矩阵仍未验证，`paseo plugin ls` 文本与 `_probe` 的 API 行为也可能随版本变。 | **实测**（0.9.2 tarball 符号核对）+ **未验证**（运行时矩阵） | 基线已有（上轮驳回"0.9.2 必错"，本轮维持） |

## 3. 已核实（正向结论，不是问题）

- **发布产物完整**：`npm pack --dry-run --ignore-scripts` 43 个文件，`bin/`、`lib/`、`server/`、`client/`、`shared/`、两个入口、`paseo-plugin.json`、`README/OVERVIEW/LICENSE/icon.svg` 全在；`files` 列出的 12 个路径全部存在；`package-lock.json` 的 name/version/依赖四组与 `package.json` 完全一致（0.2.16）。
- **内嵌桥新鲜**：`harness/bridge-assets-check.mjs` 2/2 通过（21 个 bridge 文件逐字节一致、最长行 84 字符）；doctor 在本机真实安装上全绿且 `bridge provisioned (21 files)`（只读）。
- **类型与现有回归**：`npx tsc --noEmit` exit 0；`harness/doctor-check.mjs` 29/29、`harness/probe-check.mjs` 21/21 通过。
- **manifest 与宿主契约**：`paseo-plugin.json` 通过真实 Paseo 0.14.0 的 `PluginManifestSchema`（`requirements` 只允许 `paseo`，`>=0.9.2` 是合法 semver range，安装时经 `assertPluginCompatibility` 校验）；`id: dsh-paseo` 与 install.sh/真实配置一致；provider `icon: "icon.svg"` 的资产在发布包内。
- **install.sh**：`bash -n` 通过；`paseo plugin install` 是 0.14.0 合法子命令（`install|add`）；沙箱内连跑两次幂等（已有 profile 文件不重写、cordis.patch.yml 模板保留、只新增带时间戳的 config 备份）；`--profile` 与 `DSH_PASEO_PROFILE` 的一致性检查有效。
- **probe 泄密防护主干有效**：Authorization 回显 key、`--api-key-env <KEY>` 误用均被脱敏/拒绝（probe-check 21/21 含这两条）；DLV-08 是 query 形式的缺口，不是主干失效。
- **doctor 的宿主 CLI 行**：`paseo plugin ls` 在当前 0.14.0 真实输出（表头 + `dsh-paseo running yes ...`）下能正确匹配 `dsh-paseo plugin running`。

## 4. 健康度评分（1-5）

| 维度 | 分数 | 依据 |
|---|---|---|
| 正确性 | **3** | 安装完整性大部分检查真实有效（YAML 语法、bridge 缺文件、凭据空值、CLI/版本下限），但 DLV-01/02 两个核心判定在实测中给出错误结论；doctor 可被 7 类无效配置绕过 |
| 健壮性 | **3** | bin/lib 的 EPIPE、doctor 的 fail-closed 分支做得细；但 tools 启动器漏防护、doctor 无超时/DSH_HOME 解析不一致、probe 无整体超时/参数解析不一致 |
| 可维护性 | **3** | 注释和单一来源意识强（bridge-assets 生成/校验、bootstrap home 解析）；但 doctor 语义校验仍是脆 regex、CI 门清单双份维护（DLV-12）、install.sh 与宿主配置写两份 |
| 契约一致性 | **3** | manifest/peer 声明与 0.9.2 类型面相符、发布产物完整；但 `requirements.paseo>=0.9.2` 无运行时矩阵，doctor 版本门对 0.2.2-alpha 判 ok（文档已声明的限制） |
| 安全 | **3** | probe 对 Authorization/key 回显防护有效、不落盘 key；但 query 凭据会回显到 stdout（DLV-08），install.sh 会静默重开全局插件开关（DLV-10） |
| 依赖 | **4** | 无运行时 `dependencies`、peer 可选、lock 与 manifest 一致、内嵌桥无外部依赖；只缺 `engines` 声明（DLV-15） |
| 测试覆盖 | **2** | 29+21 条现有断言质量不错（正/负对照、假网关、沙箱 profile），但恰好在两个最重要的语义判定上留了盲区（DLV-03），CI 也不跑普通提交（DLV-13） |

**总评（一句）**：安装/发布链路本身健康、自检工具正在变好，但 doctor 与 probe 仍会把"坏配置/临时鉴权故障"报成可用结论，且现有回归恰好绕开这两点——这是"doctor 全绿不算数"在交付层的具体体现。

## 5. Top 问题（≤5）

1. **DLV-01 / P2**：doctor 的 YAML 语义仍按 regex 跨区块猜，7 类无效配置（含 `provider: ""`、`disabled: true`、未定义 provider 引用）全部 `All checks passed`。
2. **DLV-02 / P2**：probe 把 baseline 后的 401/402/403 鉴权/额度故障当成能力拒绝，exit 0 且建议永久改配置。
3. **DLV-10 / P3**：install.sh 无条件 `pluginsEnabled=true` 并覆写插件条目，会静默重新启用用户已禁用的插件。
4. **DLV-03 / P3**：doctor-check 的正对照不是真实模板结构、probe-check 没有 baseline 200 后的鉴权用例——这是 DLV-01/02 能存活的直接原因。
5. **DLV-12 / P3（本轮新引入）**：CI 冲突处理清单与自动门漂移，漏 4 个离线门。

## 6. 建议优先级

1. **先修两个 P2**：doctor 改为使用解析后的真实对象（entries 数组按 `id` 定位、跳过 `disabled: true`、`config.provider/model` 非空串、`provider` 必须命中 `llm-pi-ai.config.providers` 的 key、`.credentials.yaml` 的 `refs` 对象按名取非空字符串），无法解析时输出"未验证"而不是绿；probe 把 401/402/403/408/429/5xx/传输失败统一归"环境/网络故障→unknown、不进能力结论"，只有错误体明确指向本次被探测参数时才判 rejected，且多模型分别给出是否有可靠结论。每项加"修复前红、修复后绿"回归。
2. **补 DLV-03 的测试**：doctor-check 的完整配置改真实模板结构（单独 `llm-pi-ai` 条目 + `agent-default-model`），probe-check 加 baseline 200 → 401/402/403 的序列用例。
3. **修 DLV-12**（本轮引入）并把 CI 门清单抽成单一来源（workflow 与冲突提示共用一份脚本列表），同时补 DLV-13 的 push/PR 离线门是后续独立工作。
4. **P3 批次**：DLV-04（bridge 文件非空/大小/内容校验）、DLV-05（doctor/install.sh 复用 bootstrap 的 DSH home 解析）、DLV-07/08/09（probe 参数/URL/EPIPE）、DLV-10/11（install.sh 状态尊重与版本前置）、DLV-14/15/16（打包与运行环境声明、doctor 超时与"无法确认插件在跑"的 fail-closed 口径）。
5. **DLV-06 / DLV-17**：保持文档已声明的限制，但用版本矩阵/`plugin-check` 真机门作为唯一升级判据，不再把 doctor 绿色当兼容性证据。

## 7. 阻断性与未验证边界

- **阻断性健康问题：无。** P0/P1 = 0；DLV-01/02（P2）影响的是"安装自检/能力探测的可信度"，不是当前已装环境立即不可用（本机只读 doctor 全绿、真实 daemon 插件 running）。
- 未验证（明确列出，避免当成结论）：未跑真实模型回合；未对真实 npm/Git 安装执行 `paseo plugin add`（避免装包/联网）；未验证 Paseo 0.9.2–0.13 的运行时矩阵（只核了 0.9.2 的类型符号面）；未在 macOS + Paseo.app 上验证 doctor 的 bundled CLI 优先级与 doctor-check 的 stub 行为（仅 Linux + stub）；未访问 GitHub Actions 实际运行结果（只审 workflow 配置）；DLV-04 的"空文件会导致 DSH 加载失败"是按模块语义推断，未做启动复现。
