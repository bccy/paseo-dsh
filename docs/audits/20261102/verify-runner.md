# 当前 HEAD 离线检查执行报告（2026-11-02）

## 0. 结论

- 基线：`2f71225`（main，工作区干净；唯一未跟踪内容为 `docs/audits/20261102/`，本报告是新增文件）。
- **共执行 56 项检查（1 次 tsc + 55 个 harness 脚本）：通过 56 / 失败 0 / 环境缺失 0。**
- 另有 **13 个检查未执行**（真实模型回合、真实 daemon、真实 profile、诊断工具），**4 个 harness 文件是基础设施不是检查**；逐条原因见 §4。
- 失败清单：**无**。
- 四个门禁全绿：`tsc --noEmit` exit 0、DSH 内部 API 契约 12/12、内嵌桥资产 2/2（21 文件逐字节一致）、`plugin-build` 判据 86/86。
- 注意：全绿只覆盖各脚本断言范围内的离线/假桥场景；真实模型回合、真实 daemon/补丁宿主、真实 profile 装载、设备 UI、性能与 alpha 兼容**均未被本次证明**（见 §5）。

## 1. 环境与执行方法

| 项 | 值 |
|---|---|
| 仓库 | `<repo>` |
| HEAD / 分支 | `2f71225b6f926a7606a6fe0782a63346ec84aea7` / `main` |
| 工作区 | `git status --porcelain` 仅 `?? docs/audits/20261102/`；执行前后一致，未改动任何 tracked 文件 |
| Node / DSH / Paseo | v22.23.1 / 0.2.1-rc.5 / 0.14.0（`paseo --version`） |
| DSH 安装目录 | `<dsh install>` |
| Paseo checkout（`HOST_APP`） | `<paseo checkout>` |

执行方式：

1. 每个脚本单独进程运行（`timeout` 保护），记录 exit code 与墙钟耗时；完整 stdout/stderr 留在 `/tmp/verify-runner-logs/<script>.log`（临时目录，不入库）。
2. 运行前逐个读脚本头部注释分类，排除需要真实模型、真实 daemon、真实 profile 或诊断用途的脚本（清单见 §4）。
3. 需要编译产物的检查分两种：标注 `plugin-build.cjs` 的自动编译到自己的 `paseo-plugin/.dbg-*`；头部要求手工编译的 18 个脚本，统一编译到 `paseo-plugin/.dbg-verify`（`gitignored`）后按各自头部流程把脚本复制进该树运行。编译期 tsc 报类型错误是这些脚本头部声明的预期行为（`--moduleResolution node` 下），只看运行结果。
4. 假桥/插件级脚本自身设置一次性 `DSH_HOME`；本次未写入真实 `~/.dsh` profile、未跑真实模型回合、未碰 daemon。`catalog.mjs` 会拉起真实 `dsh --profile paseo`，但只读目录，不创建 agent、不跑回合。

## 2. 汇总表

| 指标 | 数量 |
|---|---|
| 总检查数 | **56**（tsc 1 + harness 脚本 55） |
| 通过 | **56** |
| 失败 | **0** |
| 环境缺失 | **0** |
| 跳过/未执行 | **13**（另 4 个基础设施文件不计检查） |
| 失败清单 | 无 |

补充：55 个已执行的 harness 脚本中，3 个是门禁脚本（`dsh-api-contract-check`、`bridge-assets-check`、`plugin-build-check`）；其余 52 个按类型分列于 §3.2–§3.6。

## 3. 逐项结果

### 3.1 类型与契约门（4 项）

| 脚本/命令 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| TypeScript | `cd paseo-plugin && npx tsc --noEmit` | 0 | 4.96s | 通过 | 无输出；项目自身 `tsconfig.json` 全量类型检查 |
| `dsh-api-contract-check.mjs` | `node harness/dsh-api-contract-check.mjs` | 0 | 0.10s | 通过 12/12 | DSH 0.2.1-rc.5，8 个包 0 failed；清单双向覆盖（无漏登记、无死条目） |
| `bridge-assets-check.mjs` | `node harness/bridge-assets-check.mjs` | 0 | 0.06s | 通过 2/2 | `bridge-assets.ts` 与 `dsh-bridge/`+`templates/` 的 **21 个文件逐字节一致** |
| `plugin-build-check.mjs` | `node harness/plugin-build-check.mjs` | 0 | 7.21s | 通过 86/86 | 全部场景为双向断言；临时 scratch 已自动清理，未改仓库依赖树 |

### 3.2 纯模块离线检查（直跑，18 项）

命令统一为 `node harness/<脚本>`，均在仓库根目录执行。

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `archived-lineage-check.mjs` | `node harness/archived-lineage-check.mjs` | 0 | 0.05s | 通过 12/12 | 桥的归档血统规则与 `underArchivedSession` 逐字等价 |
| `doctor-check.mjs` | `node harness/doctor-check.mjs` | 0 | 0.37s | 通过 29/29 | 真实 `runDoctor()` 跑沙箱 `DSH_HOME`；坏配置必须 fail、完整配置通过（正反对照） |
| `fake-bridge-multi-check.mjs` | `node harness/fake-bridge-multi-check.mjs` | 0 | 1.00s | 通过 23/23 | 假桥 `multi` 场景纯协议层：一会话一答案、每会话一次 `turn/end` |
| `file-mutation-gate-check.mjs` | `node harness/file-mutation-gate-check.mjs` | 0 | 0.07s | 通过 6/6 | freeze 排空在飞写入、超时重开准入 |
| `file-snapshot-check.mjs` | `node harness/file-snapshot-check.mjs` | 0 | 0.93s | 通过 56/56 | 真实临时目录下的 journal/objects/rescue 布局与恢复计划 |
| `frame-reader-check.mjs` | `node harness/frame-reader-check.mjs` | 0 | 7.69s | 通过 32/32 | 20 MB 帧跨数千 chunk 逐字节还原；旧实现 oracle 对照；默认上限 256 MiB |
| `image-host-path-check.mjs` | `node harness/image-host-path-check.mjs` | 0 | 0.08s | 通过 42/42 | 图片块 `hostPath` 注入与 history 重放投影 |
| `mcp-gateway-guard-check.mjs` | `node harness/mcp-gateway-guard-check.mjs` | 0 | 0.56s | 通过 70/70 | 网关 `tool` 参数守卫；被拒调用不发出请求（loopback 假 server 佐证） |
| `mcp-gateway-transport-check.mjs` | `node harness/mcp-gateway-transport-check.mjs` | 0 | 0.22s | 通过 10/10 | `url`→HTTP / `command`→stdio 的排他判定与点名报错 |
| `mcp-http-check.mjs` | `node harness/mcp-http-check.mjs` | 0 | 5.30s | 通过 55/55 | 桥的 MCP streamable-HTTP 客户端（SSE/JSON、session id、404 判定） |
| `mcp-stdio-check.mjs` | `node harness/mcp-stdio-check.mjs` | 0 | 1.25s | 通过 22/22 | 桥的 MCP stdio 客户端：握手顺序、非 JSON stdout、超时、子进程退出 |
| `paseo-system-envelope-check.mjs` | `node harness/paseo-system-envelope-check.mjs` | 0 | 0.06s | 通过 33/33 | `<paseo-system>` 信封两形翻译、system 保持 user turn、非字符串拒绝 |
| `probe-check.mjs` | `node harness/probe-check.mjs` | 0 | 0.33s | 通过 21/21 | probe 的退出码与泄密防护（200+error/HTML、4xx 回显 key、全 429） |
| `revert-shape-probe.mjs` | `node harness/revert-shape-probe.mjs` | 0 | 0.11s | 通过 10/10 | 用本机已装 `@deepseek-ai/dsh-session` 验证替换事件形状被真实 Session 接受 |
| `rewind-merge-check.mjs` | `node harness/rewind-merge-check.mjs` | 0 | 0.12s | 通过 49/49 | 父/子文件快照归因：child/grandchild 归根 journal、断链 fail-open、独立树不串 |
| `snapshot-lifecycle-check.mjs` | `node harness/snapshot-lifecycle-check.mjs` | 0 | 0.21s | 通过 8/8 | 捕获序号跨重启续数、旧 journal 歧义拒绝 |
| `surface-check.mjs` | `node harness/surface-check.mjs` | 0 | 0.16s | 通过 18/18 | 重放折叠：只折本桥撤回缝、compaction 不折、无法解析不改 |
| `transport-frame-check.mjs` | `node harness/transport-frame-check.mjs` | 0 | 12.32s | 通过 20/20 | 入站分帧：20 MB 帧逐字节还原、`\r\n`/空行/残行/畸形行；旧实现 oracle + 耗时对照 |

### 3.3 自动编译类检查（10 项）

这些脚本通过 `harness/plugin-build.cjs` 自行编译到各自 `paseo-plugin/.dbg-*`（`gitignored`）。

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `child-crash-check.mjs` | `node harness/child-crash-check.mjs` | 0 | 5.67s | 通过 8/8 | 子代理回合中 SIGKILL 共享子进程：子/根都收到点名 `session.runtime_failed`，子先于根 |
| `concurrent-open-check.mjs` | `node harness/concurrent-open-check.mjs` | 0 | 2.01s | 通过 14/14 | 并发 `session.open` 事务守卫两窗口 + 重新 open 成功 |
| `context-usage-check.cjs` | `node harness/context-usage-check.cjs` | 0 | 14.56s | 通过 15 项 PASS | 真实 `DshSession` 只替换进程传输：用量上报边界、缓存补发、关闭后不发布 |
| `host-contract-sim.mjs` | `node harness/host-contract-sim.mjs` | 0 | 4.05s | 通过 7/7 | **仅当前已装 patched 宿主**；canary 被截、晚发 canary 存活。stock 半场未跑，见 §4.2 |
| `multi-session-check.mjs` | `node harness/multi-session-check.mjs` | 0 | 15.46s | 通过 35/35 | 两 Paseo 会话共用一个 `dsh` 子进程：不串台、引用计数、孤儿帧清理 |
| `process-crash-check.mjs` | `node harness/process-crash-check.mjs` | 0 | 4.35s | 通过 7/7 | 大帧写给已死子进程：无 uncaughtException、请求立刻失败且可见 |
| `revert-check.mjs` | `node harness/revert-check.mjs` | 0 | 0.90s | 通过 115/115 | 撤回目标判定、可见 surface 范围、共享进程接线 |
| `replay-turn-check.cjs` | `node harness/replay-turn-check.cjs` | 0 | 5.20s | 通过 8 项 PASS | 重放必须发成对 `session.turn`；撤回回合不发、信封行归属正确 |
| `p003-permission-check.cjs` | `node harness/p003-permission-check.cjs` | 0 | 5.57s | 通过 6 项检查 | 真实 `DshProcess`/`DshSession` + 脚本化 stdio peer：权限卡与进程退出 |
| `p003-timeline-check.cjs` | `node harness/p003-timeline-check.cjs` | 0 | 3.97s | 通过 8 项检查 | 真实 TimelineBuilder → ProviderEventSchema → 客户端渲染数据 |

### 3.4 依赖本机 DSH 安装的只读驱动检查（4 项）

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `bridge-server-check.mjs` | `node harness/bridge-server-check.mjs` | 0 | 0.15s | 通过 34/34 | 与 `plugin-build` 同级分类为直跑；按模块钩子加载真实 `server.js`：usage 不复活已关闭会话、归档状态读取失败点名、每个 case 方法存在 |
| `factory-ownership-order-check.mjs` | `node harness/factory-ownership-order-check.mjs` | 0 | 0.26s | 通过 5/5 | `beginOwner` 接在真实 DSH agent factory 的 `setup` 上且在发布之前；无模型请求 |
| `p003-bridge-check.mjs` | `node harness/p003-bridge-check.mjs` | 0 | 0.16s | 通过 10 项检查 | 真实桥模块 + recording transport，无 profile/模型调用 |
| `rewind-transaction-check.mjs` | `node harness/rewind-transaction-check.mjs` | 0 | 0.24s | 通过 7/7 | 撤回事务：flush 期间子代理写入纳入恢复、二次计划、门禁释放 |

### 3.5 手工编译类检查（18 项）

统一编译树：`paseo-plugin/.dbg-verify`（由 `plugin-build.cjs` 的全量编译生成），脚本及 `fake-dsh-bridge.mjs` 复制到该目录后运行；命令为 `cd paseo-plugin/.dbg-verify && node <脚本>`。

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `agent-message-check.cjs` | `node agent-message-check.cjs` | 0 | 0.08s | 通过 111/111 | agent_message 行映射与英文标签对齐官方 display model |
| `assistant-retry-check.cjs` | `node assistant-retry-check.cjs` | 0 | 0.86s | 通过 8/8 | 同 step 重试：两 attempt 不同 id、durable 落在第二个 |
| `assistant-stream-check.cjs` | `node assistant-stream-check.cjs` | 0 | 0.82s | 通过 7/7 | 增长快照同 id、`id === messageId`、折叠后一行 |
| `image-check.cjs` | `node image-check.cjs` | 0 | 1.11s | 通过 8/8 | 带 `hostPath` 图片块恰好一条 markdown `assistant_message` |
| `jobs-poll-check.cjs` | `node jobs-poll-check.cjs` | 0 | 0.25s | 通过 33/33 | poll-sequence 许可判定；旧算法被断言为失败对照 |
| `jobs-popover-check.cjs` | `HOST_APP=<paseo checkout> node jobs-popover-check.cjs` | 0 | 0.40s | 通过 207/207 | 几何/状态标记/JSX 接线/宿主主题数据；HOST_APP 已提供 |
| `locale-check.cjs` | `node locale-check.cjs` | 0 | 0.14s | 通过 263/263 | locale 解析链与中英标签表覆盖 |
| `mcp-injection-check.cjs` | `node mcp-injection-check.cjs` | 0 | 6.70s | 通过 40/40 | per-session `paseo/mcp/set` 帧、共享子进程、gateway/stdin 白名单 |
| `newest-check.cjs` | `node newest-check.cjs` | 0 | 0.12s | 通过 36/36 | 最新行/脉冲判定：位置、提交批次、窗口、交接、时钟 |
| `session-request-check.cjs` | `node session-request-check.cjs` | 0 | 0.56s | 通过 21/21 | sessions 导入列表与撤回回执；canary 恰好一条且在回执前 |
| `steer-check.cjs` | `node steer-check.cjs` | 0 | 1.80s | 通过 25/25 | 插话回执与 `activeForegroundTurnId` 匹配；未取消子代理 |
| `style-check.cjs` | `node style-check.cjs` | 0 | 0.06s | 通过 253/253 | `client/tokens.ts` 常量表 |
| `subagent-check.cjs` | `node subagent-check.cjs` | 0 | 25.52s | 通过 90/90 | 子会话可见性、归档用例（含 replay 过滤与拒绝必须 `request.failed`） |
| `sweep-check.cjs` | `node sweep-check.cjs` | 0 | 0.05s | 通过 25/25 | 扫光几何：停点、阶梯 alpha、1.5s/0.3s、`steps(48)` |
| `thinking-check.cjs` | `node thinking-check.cjs` | 0 | 0.05s | 通过 37/37 | 思考行折叠预览首行规则与宽度接线 |
| `timeline-check.cjs` | `node timeline-check.cjs` | 0 | 0.14s | 通过 208/208 | 工具行状态机、meta 透传、9 个 detail 分支 |
| `tool-call-check.cjs` | `node tool-call-check.cjs` | 0 | 0.05s | 通过 336/336 | 工具行映射：图标/命令/diff/截断、`label` 与 `text` 不互替 |
| `uploaded-file-check.cjs` | `node uploaded-file-check.cjs` | 0 | 0.04s | 通过 17/17 | 附件块翻译与官方 `renderPromptAttachmentAsText` 逐字一致 |

### 3.6 额外探测（2 项，非断言型）

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `catalog.mjs` | `node harness/catalog.mjs` | 0 | 94.95s | 输出正常 | 真实 `dsh --profile paseo` 只读目录：providers 3（deepseek-official/deepseek-account/cpa）、models 2（均 deepseek-flash）、defaults `{"provider":"cpa","model":"deepseek-flash","reasoningEffort":"max","planMode":true}` |
| `replay-fidelity-probe.mjs` | `node harness/replay-fidelity-probe.mjs` | 0 | 0.10s | 通过 4/4 | 自动选最新真实日志 `…/994b532e-…/session.v4.jsonl.zstd`（209 events，无本桥撤回标记）；撤回缝部分用合成事件断言 |

## 4. 未执行项与覆盖差异

### 4.1 未执行的检查（13 项）

| 脚本 | 未执行原因 |
|---|---|
| `plugin-check.cjs` | 非纯离线：不设 `DSH_BINARY` 时会起真实 `dsh --profile` 跑真实模型回合（34 项含真机行为）；按任务边界排除 |
| `route-test.mjs` | 逐条路由跑真实回合 |
| `probe.mjs` | 端到端真实模型提问往返 |
| `tools.mjs` | 真实 `dsh` 的最小回合工具目录转储 |
| `stream-probe.mjs` | 真实 `dsh --profile` 的流式端到端（耗 token） |
| `rewind-e2e.mjs` | 真实 `dsh --profile paseo`、3 回合端到端（耗 token） |
| `rewind-merge-e2e.mjs` | 真实模型父子归并端到端（耗 token） |
| `rewind-native-check.mjs` | 需**打过补丁且正在运行**的 daemon，经真实 daemon 的撤回（耗 token） |
| `archive-registry-check.mjs` | 需真实 `dsh --profile`，把 `paseo/archive` 作为第一帧发给真 registry |
| `subagent-live.mjs` | 脚本明确要求主会话手工跑：真实模型回合 + 真实子代理 |
| `p003-live-check.mjs` | 真实插件 + 真实 DSH + 已配置模型；会产出可丢弃的 profile/session |
| `p003-approval-preflight.mjs` | 真实 DSH 服务 + 模型调用工具（审批路径） |
| `session-calls.mjs` | **诊断工具不是回归**：读 `$DSH_HOME/sessions` 做 schema diff，无通过/失败判据；不属于本轮检查 |

### 4.2 基础设施文件（不是独立检查，4 个）

`fake-dsh-bridge.mjs`（假 `dsh` 脚本替身）、`plugin-build.cjs`（编译与新鲜度判据，其行为由 `plugin-build-check.mjs` 覆盖）、`source-shape.cjs`（TSX 结构读取器，被其它检查 require）、`p003-live-support.mjs`（真实 profile 夹具，被排除的 live 脚本共用）。

### 4.3 与脚本自称覆盖的差异

1. **`host-contract-sim.mjs` 只跑了一半**：断言会按宿主文件是否含 `truncateHistoryFrom` 翻转，本次运行的是**当前已装 patched 宿主**（`truncates history on rewind (patched)`），7/7 只证明 patched 行为；stock 半场需要 `npm pack @getpaseo/server` 解包 + 手工 wrapper 目录（脚本头部写明），本次未做。
2. **`catalog.mjs` 不是断言脚本**：exit 0 只说明该 profile 能报出 provider/model/efforts 目录，不证明模型可调、路由可用。
3. **`replay-fidelity-probe.mjs` 的实例数据**：选中的真实日志没有本桥撤回标记（`rewind markers: 0`），撤回缝只由脚本内合成事件覆盖。
4. **`plugin-build-check.mjs` 的 scratch 构建**在 `/tmp` 私有副本中完成并已自动清理，不污染仓库。
5. **手工编译组**为满足头部“编译到 `paseo-plugin/` 下”的硬约束，统一用一棵 `.dbg-verify` 编译树顺序运行（未按每个脚本各自的 `.dbg-am`/`.dbg` 目录名各建一棵）；脚本要求的相对路径与复制件均已就位，结果见 §3.5。该目录在 `.gitignore` 的 `.dbg-*` 规则内，未入库。
6. 编译期 tsc 类型错误是这些脚本头部明确声明的预期现象（`--moduleResolution node` 下），不算失败；退出码均为 0，运行结果正常。

## 5. 「通过」能证明什么、不能证明什么

**能证明：**

- 当前 HEAD `2f71225` 的 `paseo-plugin` 源码在项目自身 `tsconfig.json` 下通过 `tsc --noEmit`（0 错误）。
- 桥对 DSH 0.2.1-rc.5 内部组装包的依赖仍成立：8 个包、12 个符号存在，且 `EXPECTED` 双向覆盖（新增 import 漏登记或删除 import 留死清单都会红）。
- checkout 内的内嵌桥 `server/bridge-assets.ts` 与 `dsh-bridge/` + `templates/` 的 21 个文件逐字节一致（资产新鲜度）。
- `plugin-build.cjs` 的新鲜度/构建戳判据在 86 个双向场景下成立（陈旧、残缺、缺戳、配置变化、编译输入变化均 fail closed）。
- 52 个离线/假桥脚本各自断言范围内（协议形状、状态机、恢复计划、MCP 客户端/网关、多会话隔离、崩溃失败通道、重放折叠、客户端数据层、doctor/probe 判定等）在当前源码与当前本机 DSH 安装下通过。
- 本机 `paseo` profile 能报出目录：providers 3 / models 2 / defaults 为 cpa + deepseek-flash + max + planMode true。
- 选定的本机真实会话日志可通过桥的重放折叠保真探针（209 events）。

**不能证明：**

- **真实模型回合**：`plugin-check.cjs`、`route-test`、`probe`、`stream-probe`、`rewind-e2e`/`rewind-merge-e2e`、`p003-live-check`、`p003-approval-preflight` 全部未跑；真实 provider/凭据/路由/模型行为、空模型目录、提示词装配失败等 FIELD-NOTES #58 类问题不在覆盖内。
- **真实 daemon 与补丁宿主端到端**：`rewind-native-check` 未跑；`host-contract-sim` 只覆盖当前 patched 宿主，stock 宿主行为未验证。
- **真实 profile 路径**：`archive-registry-check` 未跑，`paseo/archive` 在真实 registry 上是否可达未验证；`bridge-assets-check` 只证明 checkout 资产一致，不证明 live `~/.dsh/profiles/paseo` 已装载新桥。
- **设备 UI**：iOS/Android/React Native 的渲染、脉冲、布局、扫光均未在真机验证；本报告只覆盖数据层与源结构断言。
- **性能/容量**：除 `frame-reader`、`transport-frame` 的微基准（20 MB 帧、耗时对照）外，无压力、峰值内存或并发规模数据。
- **其它 DSH 版本**：本次只对已装 `0.2.1-rc.5` 验证；alpha 或未来 rc 的内部符号/语义变化不在覆盖内。
- **脚本判据本身的完备性/假绿风险**：本报告只执行脚本，不评判断言是否足以抓住目标缺陷；该问题属于 `harness-bridge` / `harness-plugin` 审查 lane 的范围。
