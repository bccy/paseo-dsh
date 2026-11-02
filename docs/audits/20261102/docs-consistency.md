# 文档与实现一致性审查（docs-consistency）

- 审查基线：`2f71225`（main，工作区干净；仅 `docs/audits/20261102/` 为未跟踪报告目录）
- 环境：DSH 0.2.1-rc.5 / Paseo 0.14.0 / Node v22.23.1（`doctor` 实测）
- 范围：AGENTS.md、README.md、README.en.md、paseo-plugin/README.md、paseo-plugin/OVERVIEW.md、docs/ADOPTION.md、docs/REWIND.md、docs/IMPL-CONTRACT.md、docs/FIELD-NOTES.md、docs/PLAN-REWIND-NATIVE.md、docs/PROGRESS-REWIND-NATIVE.md、docs/ONE-PROCESS-MULTI-SESSION-PLAN.md、docs/RENDER-PLAN.md
- 方法：逐份通读；对照 `paseo-plugin/server/*.ts`、`dsh-bridge/lib/*.js`、`paseo-plugin/lib/*.mjs`、`paseo-plugin/bin/paseo-dsh.mjs`、`install.sh`、`harness/*`。只读实测：`node paseo-plugin/bin/paseo-dsh.mjs doctor`（exit 0）、`dsh --profile paseo --dump-config`（plan-mode 恢复块生效）、`node harness/dsh-api-contract-check.mjs`（12/12，8 个包）、`node harness/image-host-path-check.mjs`（42/42）、`node harness/doctor-check.mjs`（29/29）、`env -u NODE_OPTIONS node local-patches/apply-rewind-history-truncation.mjs --check`（rewind+turnId 都在位）、`npm view paseo-dsh/@getpaseo/cli`（只读 registry 查询）。未运行真实模型回合、未写真实 profile、未安装依赖。

## 总览

P0 0 / P1 0 / P2 4 / P3 11。核心架构、命令入口、protocol 契约类断言基本成立；问题集中在「版本/发布状态的当前事实」明显滞后、上一轮已指出的两处漂移仍未修，以及少量行号、能力清单和语言声明不精确。

## 1. 发现清单

| ID | 严重度 | 文档位置 | 文档说法 | 实际行为 | 证据等级 | 漂移类型 |
|---|---|---|---|---|---|---|
| D01 | P2 | `paseo-plugin/OVERVIEW.md:9` | "Paseo 的转录只渲染 `https://` Markdown 图片；本地路径、`file://`、base64 都不显示，守护进程产出的图片必须先发布成 URL" | 桥 `dsh-bridge/lib/image-host-path.js:178-232` 给 `tool/result` 每个图片块追加 `hostPath`（无扩展名时复制成带扩展名的临时副本）；插件 `paseo-plugin/server/timeline.ts:116-151` 为带 `hostPath` 的块发 `assistant_message`，文本为 `![alt](file:///...)`；`harness/image-check.cjs:1-30` 明确该形状是 Paseo 经 file RPC 取字节的唯一形状；FIELD-NOTES #28（`:660-684`）记录"看得见"的修复，`harness/image-host-path-check.mjs` 42/42 | 源码+实测 | 事实漂移 |
| D02 | P2 | `docs/ADOPTION.md:383` | "bridge 的子进程是**每个会话新起的**，所以 bridge 的改动会立即生效" | 一个 provider 连接只有一个共享 `dsh` 子进程：`paseo-plugin/server/provider.ts:319`（`DshConnection`）、`:364`（`#pooled`）、`:413`（`#poolClaims`）；且插件每次加载都把内嵌桥整体重写进 profile（`paseo-plugin/server/bootstrap.ts:127-137`），已运行子进程不会热加载。同文档 §0（`:34-38`）与 AGENTS.md:33、README.md:271-276 均写共享进程，段落自相矛盾 | 源码 | 事实漂移 |
| D03 | P2 | `README.md:69`、`README.md:104-110`；`README.en.md:78-81`、`README.en.md:116-124`；`paseo-plugin/README.md:18-21`、`:84-85`；`AGENTS.md:183-185` | "npm 上最新发布的是 `0.2.9`（2026-10-17）…在 Paseo 0.12 上请从源码装，或等 `0.2.10` 发布" | `npm view paseo-dsh dist-tags` 实测 latest=`0.2.17`；versions 已含 0.2.10–0.2.17（按文档自己的口径"等 0.2.10"，等待条件早已满足；0.2.10 之前的 0.12 适配版本未逐版本核验）。AGENTS 的举例也仍在说"发布的 0.2.9" | 实测（npm registry） | 事实漂移（带日期的历史快照仍作为当前操作指引） |
| D04 | P2 | `README.md:452-453`；`README.en.md:530-532` | "仓库里当前是 `0.2.11`：在 npm 已发布的 `0.2.11` 基础上合入本 fork 的多会话改造与撤回能力，**尚未发布**" | `paseo-plugin/package.json:3` 实测 version=`0.2.16`；README 自己的更新日志已列到 0.2.16（`README.md:463-470`）；npm 已发布到 0.2.17。"当前 0.2.11 / 尚未发布"与仓库和 registry 都不符 | 实测+源码 | 事实漂移 |
| D05 | P3 | `README.md:336-338`；`README.en.md:383-386`；`paseo-plugin/README.md:56-58`、`:117-119` | "桥直接 import **五个** DSH 内部包（`dsh-cmdline` / `dsh-brand` / `dsh-llm` / `dsh-attachment` / `dsh-agent`）" | 桥实际 import **8** 个包：上述 5 个 + `dsh-tools`、`dsh-subprocess`、`schemastery`；`node harness/dsh-api-contract-check.mjs` 实测 12/12 并打印 "8 package(s) loaded"；AGENTS.md:289-292 也写八个。`paseo-plugin/lib/doctor.mjs:52-54` 的注释同样沿用"five"（源码注释，顺带） | 实测+源码 | 事实漂移 |
| D06 | P3 | `paseo-plugin/OVERVIEW.md:5` vs `README.md:340-341`、`README.en.md:389-392` | OVERVIEW："Node.js 22 or newer on the daemon"；README："Node ≥ 18…包**不**声明 `engines`" | `paseo-plugin/package.json` 无 `engines` 字段（实测）；代码无 Node 版本门；本机只用 Node v22.23.1 验证过。两份现行文档给出不同的最低 Node 版本，需统一 | 文档+源码（Node 18 未实测） | 表述不精确（内部矛盾） |
| D07 | P3 | `README.md:345-346`；`README.en.md:396-398`；`docs/RENDER-PLAN.md:105` | "composer 里的模式、思考档位、权限/预设下拉，以及 `/` 斜杠菜单、计划卡片、工具卡片都会跟随界面语言显示"；RENDER-PLAN："客户端接上 `DSH_PASEO_LANG`" | 服务端 copy 按 `DSH_PASEO_LANG`→`LC_ALL/LC_MESSAGES/LANG`→英文解析（`paseo-plugin/server/locale.ts:13-35`）；客户端 bundle **读不到 daemon 环境**（`paseo-plugin/client/locale.ts:9-34`），默认 `zh-CN`（`:91`），只在 transformer 收到 tool-call item 的 `metadata.locale` 时 `setLocale`（`paseo-plugin/index.client.tsx:55-68`；`paseo-plugin/server/timeline.ts:515-540` 注入）。因此首个 tool-call 前的行、已渲染的行不会跟随；且"界面语言"实际是 daemon 环境语言，不是 Paseo App 的语言设置 | 源码 | 表述不精确 |
| D08 | P3 | `README.md:456-481`；`README.en.md:537-559` | "更新日志…按 npm 发布顺序记录每个 patch 的用户可见变化"，末条 0.2.16（2026-10-28） | npm 实测已发布 0.2.17（2026-10-30T08:52Z），无 0.2.17 条目；另 0.2.15/0.2.16 的 npm 时间为 2026-10-29T08:21Z / 09:39Z，表内日期写作 2026-10-28 | 实测（npm registry） | 事实漂移 |
| D09 | P3 | `docs/ADOPTION.md:75-86` | "bridge 要实现的方法不多，DSH 这边是这 **8** 个"（initialize / catalog / prompt / cancel / plan get/set / config set / shutdown） | `dsh-bridge/lib/server.js:2946-2992` 的 `handleRequest` 分派实测有 24 个 `case`（另有 `paseo/revert`、`paseo/permission[/set]`、`paseo/usage`、`paseo/jobs`、`paseo/presets`、`paseo/sessions`、`paseo/history`、`paseo/subagents`、`paseo/archive`/`unarchive`、`paseo/commands`、`paseo/command/run`、`paseo/mcp/set`、`paseo/projections`、`session/close` 等）。8 个仍在，但作为"方法清单"已不完整 | 源码 | 表述不精确 |
| D10 | P3 | `docs/REWIND.md:54`、`:123-124`；`docs/RENDER-PLAN.md:260` | REWIND 指向 `server.js:1205-1216`（`settleAgentForRevert`）、`file-snapshots.js:69-78,116-142`（`isTrackedTool`/`mutationPathOf`）；RENDER-PLAN 指向 `server/timeline.ts:916`（`isError` 判据） | 实际：`settleAgentForRevert` 在 `dsh-bridge/lib/server.js:1824-1836`；`TRACKED_TOOLS` 在 `dsh-bridge/lib/file-snapshots.js:68`、`STR_REPLACE_EDITOR`:80、`mutationPathOf`:177-194、`isTrackedTool`:202-203；`isError` 判据在 `paseo-plugin/server/timeline.ts:1110`。三处行号均已漂移，按文档定位会指向无关代码 | 源码 | 表述不精确（行号漂移） |
| D11 | P3 | `docs/FIELD-NOTES.md:2333` | "时间线只映射 13 种会话事件里的 4 种" | `TimelineBuilder.consume()`（`paseo-plugin/server/timeline.ts:805-845`）映射 assistant/message、tool/call、tool/result、command/run、command/done、compaction/start/summary/end、turn/end 等 9 种 durable 事件；`activity-timeline.ts` 还消费 goal/change 与 tool-workflow/*；另有瞬时 `paseo/assistant-delta`。该"已知限制"条目已过时 | 源码 | 事实漂移 |
| D12 | P3 | `README.md:15-26`（能力表）；`paseo-plugin/OVERVIEW.md:7`；`paseo-plugin/README.md:37-50` | 能力清单覆盖提问卡/计划/思考/插话/图片/命令/权限/预设/会话恢复导入 | 当前实现另有：jobs pill（`paseo-plugin/client/jobs-pill.tsx:1-20`、`paseo-plugin/shared/jobs.ts`）、workflow/goal 时间线（`paseo-plugin/server/activity-timeline.ts:1-20,91-118`）、工具审批卡（`dsh-bridge/lib/approval.js`；`paseo-plugin/server/session.ts:2615-2630`）、会话级 systemPrompt（`dsh-bridge/lib/server.js:933-936,1001-1003,3630-3634`）、projections（`server.js:2662-2670,2988-2989`）。这些能力未作为能力条目出现在 README/OVERVIEW/包 README 的清单中（README 只在斜杠菜单示例里出现 `/goal`） | 源码 | 表述不精确（能力清单滞后，非错误声明） |
| D13 | P3 | `docs/ADOPTION.md:171` | "`compat.supportsDeveloperRole: false` 和 `reasoningEfforts` **必须成对出现**。只加后者会让每个回合 422" | README 的配置说明是条件性的："网关只认 `system` 角色、拒绝 `developer` 角色时必须加"（`README.md:138-141`）；支持 developer 角色的网关不需要该项。把条件性配置写成"必须成对"会误导用户关闭 developer 角色 | 文档（两份文档互相矛盾） | 表述不精确 |
| D14 | P3 | `AGENTS.md:80` | "例如 Paseo 0.15 自己刷新撤回后的时间线，于是 `local-patches` 的撤回补丁可以删" | `docs/REWIND.md:135-136` 记录上游 #4667 仍 open、修复 PR 关闭未合并、0.11.2/0.11.4/0.12 beta 均未修；本地 `local-patches/apply-rewind-history-truncation.mjs --check` 实测 rewind+turnId 两个 target 仍在位，说明当前仍依赖补丁。npm 存在 `@getpaseo/cli@0.15.0-beta.1`，但本仓库没有任何 0.15 验证记录 | 未验证 | 表述不精确（未验证的前瞻写成事实） |
| D15 | P3 | `docs/FIELD-NOTES.md`（编号体系）；`AGENTS.md:59` | AGENTS 称 FIELD-NOTES "编号到 71，含 `b`/`c` 补记"，文档自身按条目号被引用（如"第 58 条""第 59/60/61/62 条"） | 实测标题：编号 22 出现两次（`:428`/`:2261`），23 出现三次（`:384`/`:475`/`:2280`），24 两次（`:521`/`:2299`），25 两次（`:555`/`:2316`），46/47 各两次（`:1482`/`:1566`、`:1517`/`:1584`）；且第 23 条（`:384`）排在第 22 条（`:428`）之前，54 缺失。按编号引用会歧义 | 文档 | 表述不精确（历史记录内部编号错乱） |

## 2. 历史文档核对（不计漂移）

| 文档 | 状态标记 | 核对结论 |
|---|---|---|
| `docs/IMPL-CONTRACT.md:3` | "历史文档，内容保持当时原样" | 已声明冻结；文中 `parked-sessions.ts`/`parked-sessions-check.cjs` 删除说明与 HEAD 一致；行号锚点属当时快照，不作为漂移 |
| `docs/PLAN-REWIND-NATIVE.md:3` | 同上 | 历史计划，不核对当前实现 |
| `docs/PROGRESS-REWIND-NATIVE.md:3` | 同上 | 历史进度，不核对当前实现 |
| `docs/ONE-PROCESS-MULTI-SESSION-PLAN.md:3` | 同上 | 历史方案，且其目标"一进程多会话"已落地（provider.ts `#poolClaims`），不再作为当前事实 |
| `docs/FULL-AUDIT-20261020.md:3`（范围外但 AGENTS.md 索引到） | "历史文档，内容保持当时原样" | 其 `:26` "systemPrompt 未做"已被当前实现推翻（`dsh-bridge/lib/server.js:933-936,1001-1003,3630-3634`）；因已带历史标记，按历史记录处理，但建议在文档包中同步标注"见当前实现" |
| `docs/FULL-AUDIT-20261029.md`（范围外） | 带日期快照，无"历史文档"标记 | 基线 `37a5f87`，内容属时点审查；引用其中"未修项"前应先对 HEAD 复核 |

## 3. 未验证项

1. **Node 最低版本**：README 写 ≥18、OVERVIEW 写 22；`paseo-plugin/package.json` 无 `engines`，本机仅 Node 22.23.1 实测。Node 18/20 是否真能跑未验证。
2. **Paseo ≥0.9.2 兼容**：本机仅装 0.14.0；包的 `peerDependencies`/`paseo-plugin.json` 声明 `>=0.9.2`，但新功能（jobs RPC、timeline transformer 等）在 0.9.x 上是否可用未验证。
3. **AGENTS.md:80 "Paseo 0.15 自己刷新撤回时间线"**：`@getpaseo/cli@0.15.0-beta.1` 存在，但未安装、无本仓库验证记录；REWIND.md 的上游 #4667 记录相反（open）。
4. **README.md:287 / ADOPTION.md:284 "子代理第二次派发时显示运行中"**：说明为"上游 #8080 已修复并合入 main，等 Paseo 发版"；本机 0.14.0 未做真机复测，无法确认发版状态。
5. **FIELD-NOTES 已知限制中 0.11.2 基线的三条**（`:2334`、`:2336`、`:2338`）：本机 Paseo 0.14.0 未复测，按历史基线保留。
6. **AGENTS.md:45 "macOS 桌面版自带签名 CLI 根本打不了补丁"**：本机 Linux，未验证。
7. **`harness/plugin-check.cjs` 的 34 项含真实模型回合**：静态计数 34 个 `check(` 与文档一致；本次按约束未实际运行（会耗 token、并重写真实 profile 的桥），只记为未执行。

## 4. 总评与建议

**总评：** 文档主体（AGENTS/README/REWIND）与当前实现的核心架构、命令入口、协议契约基本吻合，未发现 P0/P1 级误导；但"版本/发布状态"这一类当前事实更新明显滞后，上一轮已指出的两处漂移（OVERVIEW 图片反向声明、ADOPTION 每会话起桥）仍在，另有若干行号与能力清单不精确——涉及版本、发布状态和加载时机的断言不应直接当结论使用。

**Top 问题（≤5）：**

1. **D01（P2）** `paseo-plugin/OVERVIEW.md:9`：把已实现的工具图片 `file://` 显示说成"不显示"，与 image-host-path + timeline 图片行实现完全相反。
2. **D02（P2）** `docs/ADOPTION.md:383`：共享进程模型下仍写"每会话新起 bridge 子进程、改动立即生效"，会让维护者在旧代码上验证得到假绿。
3. **D03（P2）** README 中文/英文/包 README 多处：npm 最新版本仍写 `0.2.9`、建议 "等 0.2.10"，实际已到 `0.2.17`。
4. **D04（P2）** `README.md:452-453` / `README.en.md:530-532`：仓库当前版本仍写 `0.2.11` 且"尚未发布"，实际 `0.2.16` 且 npm 已发 `0.2.17`。
5. **D05（P3）** README 中文/英文/包 README：桥依赖说五个 DSH 内部包，实际八个（`dsh-tools`/`dsh-subprocess`/`schemastery` 漏报，低估升级检查面）。

**建议优先级：**

1. **立即（单文件小改，P2）**：D01、D02、D03、D04——发布文档包前必须改；D01/D02 属上一轮已指出的遗留项。
2. **同批（P3）**：D05、D07、D09、D10、D11、D12、D13、D14、D15、D06、D08——统一版本口径、补能力清单、把行号引用改为符号名或函数名，消除文档内部矛盾。
3. **流程建议**：每次 bump `paseo-plugin/package.json` 时同步更新 README「版本策略」「更新日志」「安装提示」三处；ADOPTION §5.5 改为"改 bridge 必须重新生成 `bridge-assets.ts` 并重载插件/重启 daemon；共享子进程建立后不会热加载"；历史审计文档统一加历史标记。
