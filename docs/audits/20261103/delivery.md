# 交付层（doctor / probe / bin / CI / 发布）全量健康度审查（2026-11-03）

- 审查基线：`0c82df5`（main）。工作区仅有未跟踪的 `V1.txt`/`v1.txt` 与本轮审计目录 `docs/audits/20261103/`。
- 环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node `v22.23.1`、npm latest `paseo-dsh@0.2.17`（仓库 `paseo-plugin/package.json` 为 `0.2.16`）。
- lane：delivery（只读）。本报告是唯一写入的文件。
- 本轮任务：全量复审交付层，并核查修复轮 `6394809` 声称的 D1、D2/DLV-02、DLV-12（以及顺带核 DLV-03/DLV-04）是否真的落地。

## 1. 范围与方法

### 1.1 通读范围（全文，非抽样）

| 文件 | 行数 | 说明 |
|---|---|---|
| `paseo-plugin/lib/doctor.mjs` | 631 | 安装完整性自检 |
| `paseo-plugin/lib/probe-provider.mjs` | 390 | 模型能力探测（`tools/probe-provider.mjs` 与 `bin` 共用） |
| `paseo-plugin/bin/paseo-dsh.mjs` | 57 | 发布包 CLI 入口 |
| `tools/probe-provider.mjs` | 17 | checkout 用瘦启动器 |
| `paseo-plugin/scripts/generate-bridge-assets.mjs` | 95 | 内嵌桥生成（`prepack`） |
| `install.sh` | 266 | checkout/目录源安装脚本 |
| `.github/workflows/sync-upstream.yml` | 161 | 仓库**唯一** workflow |
| `paseo-plugin/package.json`、`paseo-plugin/paseo-plugin.json`、`templates/cordis.patch.yml` | — | 发布边界、manifest、profile 模板 |
| `README.md` / `README.en.md` 的安装与发布入口、`paseo-plugin/README.md`（随包分发） | — | 交付流程正确性 |

### 1.2 必须对照的文档/源码

- `docs/FULL-AUDIT-20261102.md` §3.2（D1/D2）、§10.1（p8-delivery 行）、`docs/audits/20261102/delivery.md`（上轮 DLV-01～17）。
- `docs/AGENTS.md`「发布流程（硬性）」「跟 DSH 升版」「改完怎么验证」；`docs/ADOPTION.md`；`docs/FIELD-NOTES.md` 第 58 条；`docs/HARNESS.md`。
- 已装 DSH `0.2.1-rc.5` 的真实实现（判断 doctor 的语义假设是否与宿主一致）：
  - `dsh-app-boot/lib/index.js` 的 `applyEntryPatches`（profile 补丁应用语义）；
  - `dsh-credentials-local/lib/index.js`（`.credentials.yaml` 的 version/权限/refs 键语法与激活失败语义）；
  - `dsh-base/cordis.patch.yml`（`credentials`、`agent-default-model`、`llm-pi-ai` 条目真实 name）；
  - 已装 Paseo CLI `0.14.0` 的 `plugin ls` 输出 schema（`dist/commands/plugin/index.js`）。

### 1.3 证据等级与复现纪律

- 【实测】：本轮用可复现命令/探针复现并记录 exit code 或输出片段（夹具全部在 `/tmp/delivery-audit/`，不入库）。
- 【源码推断】：读当前源码 + 已装宿主实现得出，未跑端到端。
- 【文档】：文档声明/上轮报告结论，本轮未独立复现的明确标注。
- 纪律：未跑 doctor/probe 的真实 `~/.dsh` 路径，未写真实 profile，未起真实 daemon、未跑真实模型、未装包、未 `npm publish`、未 git 写。所有 doctor 复现使用 `mkdtemp` 的 `DSH_HOME` + PATH stub；所有 probe 复现使用 loopback 假网关；DSH 行为复现使用 `/tmp` 临时 `DSH_HOME` + 本地 `dsh` CLI（不联网、不发模型请求）。
- 复跑的上游回归（本轮实跑）：`harness/doctor-check.mjs` 37/37 exit 0；`harness/probe-check.mjs` 46/46 exit 0；`harness/bridge-assets-check.mjs` 2/2 exit 0；`harness/harness-gates-check.mjs` 41/41 exit 0；`harness/transport-frame-check.mjs` 26/26 exit 0；`harness/mcp-stdio-check.mjs` 28/28 exit 0；`harness/rewind-notice-check.cjs` 63/63 exit 0；`paseo-plugin` 下 `npx tsc --noEmit` exit 0。

## 2. 健康度评分（1–5）

| 维度 | 分数 | 依据 |
|---|---|---|
| 正确性 | **3** | D1/D2 两个核心判定已真修（见 §3.1），但 doctor 又暴露 3 类新的"契约级假绿"（凭据文档契约、补丁可应用性、profile 组成），仍是"全绿 ≠ 能跑" |
| 健壮性 | **3** | bin/lib 的 EPIPE、fail-closed 分支做得好；但 `tools` 启动器仍漏 EPIPE、doctor 的 `execFileSync` 无超时、probe 无整体 deadline |
| 可维护性 | **3** | 注释与单一来源意识强（bridge-assets 生成/校验、bootstrap home 解析）；但 CI 门清单两份手维护、doctor 依赖清单文案过期、模板引用 repo-only 路径 |
| 契约一致性 | **3** | manifest/peer 与 README 的版本下限一致（≥0.9.2 / ≥0.2.1），发布包边界干净；但 doctor 不校验 DSH 真实契约（credentials 文档 version/权限/键语法、补丁 name、profile bundles） |
| 安全 | **3** | probe 对 Authorization/key 回显的防护主干有效、不落盘 key；但 base URL query 中的凭据会回显（DLV-05），sync-upstream 的信任边界偏弱（DLV-19） |
| 依赖 | **4** | 无运行时 `dependencies`、peer 可选、lock 与 manifest 一致、内嵌桥无外部依赖；只缺 `engines` 声明（并入 DLV-20） |
| 测试覆盖 | **3** | D1/D2 的回归质量明显提升（正/负对照、真实模板形状、baseline 200→401/402/403）；但 doctor-check 的"完整安装"正对照本身不是 DSH 合法安装（缺 `version: 1`、缺 profile `package.json`），恰好绕开本轮三条新假绿；CI 仍漏两个可离线门 |

**总评：3.1/5**（较上轮 3.0 略升：两个 P2 真修 + 回归补齐；但同一层又发现三条 P2 级假绿，且 P3 欠账基本未动）。**阻断性：无**（P0/P1 = 0；已装环境本身不受影响，问题在"诊断工具给错结论"）。

## 3. 发现列表

### 3.1 修复轮核查（`6394809` 声称修复的条目）

| 条目 | 上轮状态 | 本轮结论 | 证据 |
|---|---|---|---|
| D1 / 上轮 DLV-01 | P2 未修 | **已修（真解析）** | `doctor.mjs:479-612` 用解析后的对象判路由/凭据；独立复跑上轮 7 类畸形配置：①`provider:`/②`provider: ""`/②空 config 借用后续条目/③`refs.KEY: ""`/④注释空值/⑤`refs:` 外同名 key/⑥`disabled: true`/⑦未定义 provider —— 8/8 均 exit 1 且无 `All checks passed`，正对照（完整配置）exit 0（夹具 `/tmp/delivery-audit/repro-dlv01.mjs`，9/9）；`harness/doctor-check.mjs` 37/37 exit 0 |
| D2 / 上轮 DLV-02 | P2 未修 | **已修** | `probe-provider.mjs:158-166` 对 401/402/403 显式 early-return（不看错误体措辞）；独立 loopback：baseline 200 → 其后全部 401 时 developer=`unknown`、6 档全 `unknown (401)`、**exit 1**、无 `reasoningEfforts: false`/`supportsDeveloperRole: false` 建议；baseline 直接 401 → `FAILED` + exit 1（夹具 `/tmp/delivery-audit/repro-doctor.mjs`）；`harness/probe-check.mjs` 46/46 exit 0 |
| 上轮 DLV-12 | P3（上轮新引入） | **已修** | 解析 workflow 自动门：成功路径 25 个 `harness/*` 门 == 冲突 PR 清单 25 个门（含 `rewind-merge-check`/`mcp-http-check`/`doctor-check`/`probe-check`），无差异（脚本比对，exit 0） |
| 上轮 DLV-03 | P3 测试盲区 | **已修** | `doctor-check.mjs:210-232` 正对照已改为真实模板形状（独立 `llm-pi-ai` + `agent-default-model`）；`probe-check.mjs:176-255` 已有 baseline 200→401/402/403（5b）与"错误体点名维度也必须走 unknown"（5b2，`isVerdict` early-return 的唯一回归） |
| 上轮 DLV-04 | P3 半成品桥 | **根因已修，残余仍在** | `bootstrap.ts:118-200` 改为暂存目录写后逐文件长度/哈希校验 + `rename` 原子替换；但 doctor 仍只 `existsSync`（见 DLV-10），夹具用 21 个空文件仍全绿 |

### 3.2 本轮发现

> 计数：**P0 = 0，P1 = 0，P2 = 3，P3 = 19**（共 22 条）。"归属"列区分本轮新发现 / 上轮遗留。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| DLV-01 | **P2** | `doctor.mjs:565-612`（凭据检查）、`:600-611`（修复建议）；对照 `dsh-credentials-local/lib/index.js:92-105,138-159,194-205,641-655` | `.credentials.yaml` 缺 `version: 1`、文件权限不是 0600、或 `refs` 键名不是 POSIX 标识符 | **实测**（doctor 全绿 + 真实 DSH 解析/启动失败） | 本轮新发现（D1 修复未覆盖的契约层） | doctor 只判 `refs.<name>` 是非空字符串，不校验 DSH 的文档契约：三种文档都被 DSH 的 credentials 服务拒绝激活，而 doctor 报 `[ok] credential … found` + `All checks passed` + exit 0；doctor 自己的修复建议（`:609` 只让加 `refs:` 项）与 README 推荐 agent 流程（`README.md:58`/`README.en.md:66` 只写"refs 段"）恰好会产出这种文件 |
| DLV-02 | **P2** | `doctor.mjs:192-199`（`entryById`）、`:504-563`（路由判定）；对照 `dsh-app-boot/lib/index.js:61-111`（`:101` name mismatch 跳过） | profile 补丁条目带了与宿主条目不一致的 `name:`（如手改/复制时笔误） | **实测**（doctor 全绿 + 真实 `dsh --dump-config` 证明补丁被跳过） | 本轮新发现（D1 修复未覆盖的契约层） | doctor 只按 `id` 折叠并读 `config`，不校验补丁能否被 DSH 应用。`name` 不匹配时 DSH 打印 `patch: name mismatch … skipping` 并跳过整条补丁（实测 `--dump-config` 中 `agent-default-model` 仍是 base 的 `deepseek-official/deepseek-flash`，而非用户写的 `my-gateway/my-model`），doctor 却报 `[ok] model route configured` + exit 0 |
| DLV-03 | **P2** | `doctor.mjs:409-419`（profile 只查目录存在）；对照 `bootstrap.ts:215-224`（`writeIfAbsent` 不补 bundles）、`dsh-app-boot/lib/index.js:490-503` | profile 目录存在但 `package.json` 缺失/不含 `dsh-paseo-bridge` bundle（例如 `DSH_PASEO_PROFILE` 指向一个已有 profile，或用户自定义过 `package.json`） | **实测**（doctor 全绿；DSH 对缺 `package.json` 报 `profile … does not exist`；缺 bundle 时 `--dump-config` 中 bridge 条目 0 个） | 本轮新发现（D1 修复未覆盖的契约层） | doctor 的"profile 就绪"只判 `existsSync(profileDir)`。缺 `package.json` 时 DSH 直接报 profile 不存在（实测 exit 1）；`package.json` 不含 `dsh-paseo-bridge` 时 DSH 正常启动但**根本不装载桥**（实测 dump 中 `paseo` 条目 0 vs 有 bundle 时 6），会话 `initialize` 必然超时——两种情况下 doctor 都全绿 |
| DLV-04 | P3 | `probe-provider.mjs:352-367`、`:371-377`、`:250-260` | 网关先拒绝部分档位、随后限流/超时（8 次连续调用后很常见） | **实测**（loopback：3×400 点名参数 + 3×429） | 本轮新发现 | 混合 rejected/unknown 时打印"not a result. Re-run"，但 `probed` 因存在 verdict 而不为 0 → **exit 0**；且已打印的片段只有 `- id/name`、不含 `reasoningEfforts`，按退出码判断的安装 agent 可能把它当成功结果贴进 profile（能力被静默降级） |
| DLV-05 | P3 | `probe-provider.mjs:92-101`（`redactUrl` 只清 userinfo）、`:308`（字符串拼 `/chat/completions`） | base URL 把凭据放在 query（`https://gw/v1?token=…`） | **实测** | 上轮 DLV-08 仍未修 | `endpoint:` 行原样回显 query 里的 token（stdout 会被安装 agent 贴进对话）；且请求路径变成 `/v1?token=…/chat/completions`（实测服务端收到的 path），探测必然失败 |
| DLV-06 | P3 | `probe-provider.mjs:62-82`（`parseArgs` 支持 `=`）vs `:277-279`（models 只收空格形式） | 用 `--model=<id>` | **实测** | 上轮 DLV-07 仍未修 | `--base-url=`/`--api-key-env=` 可用，`--model=m` 却报 `at least one --model is required`、exit 2 |
| DLV-07 | P3 | `tools/probe-provider.mjs:1-17`（无 EPIPE 监听）；对照 `bin/paseo-dsh.mjs:36-39`、`probe-provider.mjs:380-389` | `node tools/probe-provider.mjs … \| head -1`（README/install.sh 的写法） | **实测** | 上轮 DLV-09 仍未修 | head 关闭管道后 `Error: write EPIPE` 未捕获、打栈、exit 1 |
| DLV-08 | P3 | `doctor.mjs:341`（`process.env.DSH_HOME ?? join(homedir(),".dsh")`）；对照 `bootstrap.ts:51-83`、`dsh-home-paths` 的 `resolveRoot` | `DSH_HOME=~/alt`（字面 `~`）或 `DSH_HOME=""`/空白 | 【源码推断】（上轮实测，本轮复核源码未变） | 上轮 DLV-05 仍未修 | doctor 用字面 `join`，DSH 会展开 `~`、把空/空白当未设置并 `resolve()` → doctor 检查的 profile/凭据路径可能与真实 DSH 目录不一致 |
| DLV-09 | P3 | `doctor.mjs:565-612` | 凭据来自 daemon 环境变量/`.env`（DSH 的凭据优先级允许），或某个**未被路由使用**的 provider 没有 key | 【源码推断】（DSH `dsh-credentials-local` 文档化的优先级：managed store > 继承环境 > 项目 `.env` > 用户 `.env`） | 本轮新发现 | doctor 只认 `.credentials.yaml` 的 `refs`，且对**所有** provider 的 `apiKeyEnv` 都要求存在 → 合法安装可能被报 `[fail] credential … missing`（假红） |
| DLV-10 | P3 | `doctor.mjs:445-462`（只 `existsSync`） | 桥文件存在但内容为空/被截断/被手改 | **实测**（夹具写 21 个空文件仍全绿） | 上轮 DLV-04 残余（根因已被 bootstrap 原子替换修掉，风险降低） | doctor 只查"每个文件存在"，不查大小/哈希；现在 provision 已原子+逐文件校验，触发面缩到外部损坏/手改，但"桥是否真的完整"仍不可证 |
| DLV-11 | P3 | `doctor.mjs:56-58`、`:362`、`:368` | DSH 版本低于下限时看失败详情 | 【源码推断】+ 实测输出片段 | 本轮新发现 | 失败文案与注释仍写"bridge imports **five** DSH-internal packages（cmdline/brand/llm/attachment/agent）"；实际契约检查覆盖 **8** 个（另有 `dsh-tools`/`dsh-subprocess`/`schemastery`，见 `harness/dsh-api-contract-check.mjs:5-6,58-70`），三份 README 也都写"八个" |
| DLV-12 | P3 | `doctor.mjs:334-346`（header 打印的 `pluginVersion` 是 CLI 自身包版本）、`:390-405`（只判 `dsh-paseo` 行含 `running`）；对照 Paseo CLI `0.14.0` `plugin ls` 列（PLUGIN/STATUS/ENABLED/SOURCE/REVISION/DIRECTORY/ERROR，**无版本列**） | 已装 Paseo 插件版本与 daemon 不匹配（README 声明 Paseo 0.12 需插件 ≥0.2.10） | 【源码推断】（Paseo CLI 输出 schema 已读；doctor 无版本判断） | 本轮新发现 | `npx paseo-dsh doctor` 打印的 "plugin X" 是**下载来跑的 CLI 版本**，不是 Paseo 里已装插件的版本；`paseo plugin ls` 文本里也拿不到版本（`--json` 可以），所以 README 里那条兼容性约束 doctor 永远查不出 |
| DLV-13 | P3 | `install.sh:73-107` | `--check` 前用旧版本 `dsh`/`paseo` | **实测**（dsh 0.1.0 + paseo 0.8.0 stub：`all prerequisites present`、exit 0） | 上轮 DLV-11 仍未修 | 前置检查只判可执行文件存在，不复用 doctor 的 `MINIMUM_DSH`/`MINIMUM_PASEO`；`--check` 还写"a real install would write the model route"，而真实安装只写未配置模板 |
| DLV-14 | P3 | `install.sh:51-53`（`REPO` 不 resolve 绝对路径）、`:184-195`（`ln -s "$REPO/dsh-bridge"` + 只比 `readlink` 字符串） | `./install.sh --repo .`（相对路径） | **实测**（复现 shell 语义：软链 `repo/dsh-bridge` 相对 profile 目录解析 → 悬空；`readlink` 校验仍通过） | 本轮新发现 | 相对 `--repo` 时 profile 里的桥软链悬空，脚本仍打印"linked …"；插件加载后会替换，影响限于"插件加载前"窗口，但自检说成功是假的 |
| DLV-15 | P3 | `install.sh:209-226`；对照真实 `~/.paseo/config.json`（条目形状 `{source,path,enabled}`，只读核对） | 用户曾全局关插件或单独 `enabled:false` 禁用 dsh-paseo，再跑 install.sh | 【源码推断】+ 实测真实配置形状 | 上轮 DLV-10 仍未修 | 无条件 `config.pluginsEnabled = true` 并把条目整体覆写为 `{source,path}`（丢掉 `enabled:false`）→ 下次重启静默重新启用用户已禁用的插件（`enabled !== false` 即启用） |
| DLV-16 | P3 | `.github/workflows/sync-upstream.yml:59-107`（自动门）、`:116-153`（冲突清单）；对照 `harness/transport-frame-check.mjs`、`harness/rewind-notice-check.cjs`、`harness/mcp-stdio-check.mjs:36-53` | 改到桥分帧/撤回提示/MCP stdio 的提交 | **实测**（三个脚本均可离线跑：26/26、63/63、28/28 exit 0；但 workflow 不跑前两个） | 本轮新发现（上轮 DLV-12 已修但清单仍双份） | 门清单仍漏可离线门：`transport-frame-check`（只 import `node:string_decoder` + 真实 `transport.js`，CI 可跑）与 `rewind-notice-check.cjs`（`plugin-build.cjs` 自编译，与已进 CI 的 `jobs-poll-check` 同型）；`mcp-stdio-check` 实际依赖本机 DSH 的 `dsh-subprocess`，不能进 CI，但排除注释没提它；清单仍在 workflow 与 PR body 各维护一份（本轮内容已一致，但无单一来源） |
| DLV-17 | P3 | `.github/workflows/sync-upstream.yml:8-12`（只 `schedule`/`workflow_dispatch`）、`:51-54`（upstream 已是 ancestor 时 `exit 0`） | 本仓普通 push/PR；或当天 upstream 无新提交 | 【源码推断】 | 上轮 DLV-13 仍未修 | 仓库唯一 workflow 不覆盖本仓改动：普通提交没有任何自动门；upstream 无新提交时提前退出、连门都不跑（最近 `13951ad`…`0c82df5` 的撤回提示改动因此从未被 CI 覆盖） |
| DLV-18 | P3 | `.github/workflows/sync-upstream.yml:154-160` | 冲突分支下 `gh pr create` 失败（PR 被禁用、权限/配额等） | 【源码推断】（`|| echo "::warning::"` 吞掉非零退出，随后 `echo` 使 job exit 0） | 本轮新发现 | 冲突 PR 创建失败时 job 仍绿：main 未更新、也没有 PR，只有一条 annotation；"失败要响亮"在唯一自动流程里被绕过 |
| DLV-19 | P3 | `.github/workflows/sync-upstream.yml:40-109`（合并后 `npm ci` + 全部门禁在 merged tree 上执行，`env: GH_TOKEN` 挂在同一步；checkout 默认持久化凭据） | upstream 仓库/账号被入侵或投毒 | 【源码推断】 | 本轮新发现（安全/流程） | 自动门不是信任边界：门脚本、`npm ci` 生命周期脚本都来自被合并的上游树，runner 同时持有 `contents: write` + `GH_TOKEN`，且无 SHA pin、无环境审批/PR 复核 → 上游被入侵即可让门"自证清白"后直推 main。建议至少 pin 上游 SHA + 把 `npm ci`/门禁挪到无写权限的独立 job、push 单独 job |
| DLV-20 | P3 | `paseo-plugin/package.json:25-38`（`files` 不含 `scripts/`）、`:39-42`（`prepack` 指向 `scripts/generate-bridge-assets.mjs`）、无 `engines` | 在安装副本上二次 `npm pack`/`publish`；或在老 Node（`fetch` 要求 ≥18，桥要求 ≥20.4）上跑 probe | 【源码推断】（`engines` 字段确认缺失；`fetch`/`AbortSignal.timeout` 依赖已读） | 上轮 DLV-14/15 仍未修 | 正常在源码树内 publish 不受影响，但安装副本上 pack 会 ENOENT；包不声明 `engines`（README 明说"未实测的不写进声明"），Node <18 上 probe 是 `ReferenceError: fetch is not defined` 崩栈而非可读错误 |
| DLV-21 | P3 | `doctor.mjs:80-89`（`execFileSync` 无 `timeout`）、`:390-393`（`paseo plugin ls` 失败只 `warn`） | daemon 卡死/无响应；或 daemon 未运行 | **实测**（stub `paseo plugin ls` 失败 → `[warn] could not list Paseo plugins` + exit 0）+【源码推断】（无超时） | 上轮 DLV-16 仍未修 | 与 doctor 自己"we could not check ≠ fine"的 fail-closed 口径不一致：唯一能证明"插件在跑"的行无法检查时仍 exit 0；`execFileSync` 无超时会让 doctor 无界等待 |
| DLV-22 | P3 | `templates/cordis.patch.yml:14`（`node tools/probe-provider.mjs`） | 通过 npm/git 安装（没有仓库 checkout）的用户按模板提示操作 | 【源码推断】（模板经 `bridge-assets.ts` 内嵌、由 `bootstrap.ts:228-233` 写进每个新 profile；发布包不含 `tools/`，`npm pack` 49 文件清单已核） | 本轮新发现 | 每个新 profile 的模板都让用户跑仓库路径 `node tools/probe-provider.mjs`；npm 安装下该路径不存在，正确写法是 `npx paseo-dsh probe` |

#### DLV-01 详述（P2，最重要）

doctor 的凭据检查（`doctor.mjs:565-612`）现在是"解析 `refs` 对象 + 值是非空字符串"，但 DSH `0.2.1-rc.5` 的 credentials 服务在**激活时**还强制三件事，doctor 全都不查：

1. **必须有 `version: 1`**（`dsh-credentials-local/lib/index.js:153`）。`refs:` 单独存在但无 `version` 时，`renderFlatLayoutMigration` 认不出（它是给"扁平旧格式"用的），随后 `parseCredentialsDocument` 抛 `uses the pre-release flat layout`。
2. **文件必须仅属主可读**（`:92-105`，`assertOwnerOnly`）；`cat >`/编辑器新建的 0644 文件会让激活直接失败（错误里让你 `chmod 600`）。
3. **`refs` 键必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`**（`parseRefs` 里的 `credentialRef`），否则整个文档被拒。

实测（`/tmp/delivery-audit/repro-credentials.mjs`；下表三类均复现，脚本 4/4 中的第 4 项是 DLV-21 的 `paseo plugin ls` 失败路径）：

| 文档 | DSH 真实解析/启动 | doctor |
|---|---|---|
| `refs:` 无 `version: 1` | `dsh` 启动报 `credentials (@deepseek-ai/dsh-credentials-local): Error: … uses the pre-release flat layout …`，`authorization` 一直 `pending (waiting for service: credentials)` | `[ok] credential MY_GATEWAY_KEY found` + `All checks passed` + exit 0 |
| `version: 1` 但 0644 | 启动报 `… is readable beyond its owner (mode 644); run "chmod 600 …"` | 同上，全绿 exit 0 |
| `version: 1` + 键名 `MY.GATEWAY_KEY` | 启动报 `credential ref "MY.GATEWAY_KEY" must match /^[A-Za-z_][A-Za-z0-9_]*$/` | 同上，全绿 exit 0 |

放大问题的两点：doctor 自己的修复建议（`:609` `add "NAME: <your-key>" under refs: in …`）**不写 `version: 1`**；README 的"复制给 AI agent"推荐流程（`README.md:58`、`README.en.md:66`）也只说"写进 refs 段"（详细段 `README.md:166-172` 才有 `version: 1`）。即：按推荐流程/按 doctor 报错修，用户很可能得到一个 DSH 拒绝激活的凭据文件，而 doctor 随后报全绿。

#### DLV-02 详述（P2）

实测（`/tmp` 临时 `DSH_HOME` + 真实 `dsh --dump-config`）：

```
# cordis.patch.yml 里 agent-default-model 的 name 写错时
dsh: [.../cordis.patch.yml] patch: name mismatch for "agent-default-model"
     (expected "@deepseek-ai/dsh-agent-default-model", got "...-TYPO"), skipping
# dump 出来的合成配置：
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }   # base 的值，补丁没生效
```

同一个 profile 把 `name` 写对后 dump 出 `provider: my-gateway / model: my-model`。doctor 对这两种情况都输出 `[ok] model route configured` + exit 0（`/tmp/delivery-audit/repro-doctor.mjs`）。DSH 的 `applyEntryPatches` 还有"id 在合成树里不存在 → warn + skip"的分支（`dsh-app-boot/lib/index.js:61-111`），doctor 的 `entryById` 只在自己的补丁数组里找 id，同样无从发现。

#### DLV-03 详述（P2）

- 缺 `package.json`：doctor 的 `[ok] DSH profile at …` 之后照常检查 bridge/路由/凭据 → 全绿；真实 `dsh --profile t` 直接报 `profile "t" does not exist; create it with 'dsh plugin --profile t add <package>'`（exit 1）。
- `package.json` 有但 `dsh.profile.bundles` 不含 `dsh-paseo-bridge`：`dsh --dump-config` 中 `paseo` 相关条目 **0** 个（含 bundle 时 6 个），即桥不会被装载；插件侧 `bootstrap.ts:215-224` 的 `writeIfAbsent` 明确"用户 profile 文件不覆写"，所以这种 profile 会一直缺 bundle。doctor 仍然全绿。
- 触发面：`DSH_PASEO_PROFILE` 指向一个已有 profile（README 明确支持自定义 profile），或用户按"package.json 归用户所有"的约定改过它。

## 4. 阴性结论（核实为"不是问题"或"已修"）

1. **发布产物边界干净**：`npm pack --dry-run --ignore-scripts` = 49 个文件、512 kB；含 `bin/paseo-dsh.mjs`、`lib/doctor.mjs`、`lib/probe-provider.mjs`、`server/bridge-assets.ts`（637 kB，内嵌桥 21 文件）、`client/`、`shared/`、两个入口、`paseo-plugin.json`、`README/OVERVIEW/LICENSE/icon.svg`；**不含** `local-patches/`、`dsh-bridge/`、`harness/`、`docs/`、`scripts/`、`templates/`、`install.sh`（符合"local-patches 不是发布产物"的约定）。
2. **内嵌桥新鲜**：`harness/bridge-assets-check.mjs` 2/2 exit 0（21 文件逐字节一致、最长行 84 字符）；`tsc --noEmit` exit 0。
3. **doctor 对 D1 的七类畸形配置已真判**（见 §3.1），不再是 regex 假绿；正对照仍绿。
4. **probe 的鉴权/额度语义已修**：401/402/403 在 baseline 之后一律 `unknown` + exit 1、无永久降级建议；429/5xx/传输失败同样 unknown；只有错误体点名被测参数才判 rejected（400 点名 `reasoning_effort` → rejected + 建议，exit 0）。`probe-check` 46/46。
5. **CI 两处门清单已一致**：成功路径与冲突 PR 手动清单各 25 个 `harness/*` 门，逐项相同（DLV-12 已修）。
6. **doctor 的 Paseo 行与 0.14.0 真实输出兼容**：`paseo plugin ls` 列含 `PLUGIN/STATUS/ENABLED/…`，插件状态枚举为 `running|disabled|failed`（Paseo CLI `dist/commands/plugin/index.js:11-31` 与 protocol schema），doctor 的 `startsWith("dsh-paseo")` + `\brunning\b` 能正确命中。
7. **版本下限声明三处一致**：`package.json` peer `>=0.9.2`、`paseo-plugin.json` requirements `>=0.9.2`、doctor `MINIMUM_PASEO=0.9.2`；`MINIMUM_DSH=0.2.1` 与 README 一致；插件 `major.minor` 跟随 DSH 线的策略在 doctor 里以 warn 实现。
8. **EPIPE/退出码约定**：`bin` 与 `doctor` 都装了 EPIPE 处理（exit code 沿用 `process.exitCode`）；未知命令 exit 2；`probe` 的"什么都没探测到"exit 1（已实测 401 baseline/全 unknown 两种情况）。
9. **已知限制（文档已声明，非新发现）**：`compareCore` 只比 `major.minor.patch`、忽略预发布后缀——实测 `dsh 0.2.2-alpha.1` → `[ok]` exit 0；`0.3.0-alpha.1` → `[warn]` exit 0；`0.2.0` → fail exit 1。AGENTS.md「跟 DSH 升版」已明确写"doctor 永远不会拦住破坏性版本、唯一判据是 plugin-check"。
10. **多模型 probe 部分失败仍 exit 0**（至少一个模型有结论时）——复核后判定为设计取舍（失败模型会打印 `FAILED` 与原因），未列为发现。

## 5. 未验证项

1. 真实 `paseo plugin add npm:paseo-dsh` / `github:` 安装（装包/联网被禁），doctor 在真实 npm 安装上的输出未复核；本报告对"发布安装"的结论来自 `npm pack --dry-run` 与源码。
2. 真实 `~/.dsh` profile 与真实 daemon（按任务纪律不跑）；真实环境里 doctor 的 `paseo plugin ls`、bridge 行未取真值。
3. macOS + Paseo.app 的 bundled CLI 优先级（`findPaseo` 的 `/Applications/...` 分支）与 `doctor-check` 的 stub 行为只在 Linux 验证。
4. GitHub Actions 的真实运行结果（只审 workflow 配置）；`gh`/token 权限、分支保护对 push 的影响未验证。
5. Paseo 0.9.2–0.13 的运行时矩阵（README 声明支持 0.9.2+；本机只装 0.14.0；`paseo plugin ls` 文本与 `--json` 字段在该区间是否稳定未验证）。
6. 真实网关/真实模型的 probe 行为（只做 loopback 假网关）。
7. DLV-01/02/03 的"影响链末端"：已用真实 `dsh --dump-config`/启动日志证明"补丁不生效 / 桥不装载 / 凭据服务不激活"，但未在真实 Paseo 会话里端到端复现"回合失败"。
8. sync-upstream 在真实 upstream 提交/冲突下的行为（含 `gh pr create` 失败分支）。
9. Windows 上 `.credentials.yaml` 权限语义（DSH 在 win32 跳过 owner-only 检查；doctor 若补校验需按平台分支）。

## 6. 跨 lane 提示

- **harness lane**：
  - `harness/doctor-check.mjs:234` 的 `VALID_CREDENTIALS` 没有 `version: 1`；`install()`（`:237-252`）不写 profile `package.json`。即"完整安装"正对照本身不是 DSH 合法安装（本 lane 实测 DSH 会拒绝/报 profile 不存在），这正是 DLV-01/DLV-03 没被回归抓住的原因。建议补：`version: 1` + profile `package.json`（bundles 含 `dsh-paseo-bridge`）+ 0644/键名两类反例。
  - `probe-check` 可补 DLV-04 的 mixed rejected+unknown 用例（断言 exit code 与"片段是否含 reasoningEfforts"）。
- **docs-consistency lane**：`README.md:58` / `README.en.md:66` 的 agent prompt 块与 `docs/ADOPTION.md`（通篇没有凭据文件格式）都应补 `version: 1`；`templates/cordis.patch.yml:14` 的 repo-only `tools/` 路径应改 `npx paseo-dsh probe`（DLV-22）；README 版本段（仓库 0.2.16 vs npm 0.2.17）已有说明，请按"当前事实"再核一次。
- **plugin lane**：DLV-03 的根因之一在 `bootstrap.ts:215-224`（`writeIfAbsent` 不补 `dsh.profile.bundles`）。若维持"profile 的 package.json 归用户"，则 doctor 至少应把"桥未注册进 bundles"报成 blocking/warn，而不是静默通过。
- **process/Lead**：DLV-17（无 push/PR CI）与 DLV-19（sync-upstream 信任边界）是流程决策项，建议由 Lead 汇总后交用户拍板；DLV-16 的门清单建议抽成单一来源脚本（workflow 与 PR body 共用）。
