# 2026-11-03 全量审查 · verify-runner 实跑报告

## 0. 结论

- 基线：HEAD `0c82df5ea91fffa06e5b807940443868500521c1`（main）。工作区只有两个未跟踪文件 `V1.txt` / `v1.txt`（本轮未动），执行前后 `git status --porcelain` 一致，未改动任何 tracked 文件。
- **共执行 66 项检查（1 次 `tsc --noEmit` + 65 个 harness 脚本）：通过 66 / 失败 0 / 环境缺失 0。**
- 另有 **13 个脚本未执行**（真实模型回合、真实 daemon、真实 profile、诊断工具），`plugin-check.cjs` 只跑了离线 `--self-test` 半场；逐条原因见 §5。
- 6 个 harness 文件是基础设施、不是独立检查（见 §2）。
- **差集发现：84 个 harness 文件中，24 个未登记在 `docs/HARNESS.md`**（其中 19 个在 `AGENTS.md` 被提及，5 个两处都无索引）。与「HARNESS.md 是逐脚本穷举索引」的项目规则不符，见 §2，建议由 docs-consistency lane 处理。
- 全绿只覆盖各脚本断言范围内的离线/假桥场景；真实模型、真实 daemon、真实 profile 装载、真机 UI 均未被本轮证明（§6）。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 仓库 | `<repo>`（本 checkout） |
| HEAD / 分支 | `0c82df5ea91fffa06e5b807940443868500521c1` / `main` |
| 工作区 | `git status --porcelain` 仅 `?? V1.txt`、`?? v1.txt`；执行前后一致 |
| Node | v22.23.1 |
| TypeScript | 5.9.3（`paseo-plugin/node_modules/.bin/tsc`，本地依赖，未用 npx 拉包） |
| DSH | 0.2.1-rc.5（`<dsh install>`） |
| Paseo | 0.14.0（`<paseo checkout>` 存在，供 `HOST_APP`） |
| harness 文件全集 | 84 个（`harness/*.mjs` + `harness/*.cjs`） |

执行方式：

1. 每个脚本单独进程 + `timeout 600`，记录真实 exit code 与墙钟耗时；完整 stdout/stderr 留在 `/tmp/verify-runner-1103/<script>.log`（临时目录，不入库）。
2. 运行前逐个读脚本头部注释分类，排除需要真实模型 / 真实 daemon / 真实 profile / 诊断用途的脚本（清单见 §5）。
3. 需要编译产物的检查分两类：
   - **自编译组**：脚本内部调用 `harness/plugin-build.cjs`，各自编译到自己的 `paseo-plugin/.dbg-*`；
   - **手工编译组**：18 个脚本按头部流程需要一棵已编译插件树，本轮统一构建到 `paseo-plugin/.dbg-verify-1103`（`.gitignore` 的 `.dbg-*/` 规则内），脚本复制进该树运行；`plugin-check.cjs --self-test` 也在该树执行。
4. 编译树新鲜度核验：本轮实际使用的 17 棵 `.dbg-*` 树逐棵过 `plugin-build.cjs` 的 `freshness()`，**17/17 FRESH**（相对当前源码，无陈旧产物假绿）。
5. 未写真实 profile：假桥/插件级脚本自带一次性 `DSH_HOME`；执行后检查 `~/.dsh/profiles/**/dsh-paseo-bridge` 近 40 分钟无改动（空结果）。未跑真实模型回合、未碰 daemon。
6. 失败不重试、不掩盖；本轮没有失败项。

## 2. 脚本全集 vs `docs/HARNESS.md` 差集

从实际目录遍历（84 个文件）与 HARNESS.md 条目比对：

- HARNESS.md 显式引用 58 个 `harness/*.mjs|cjs`（**全部存在**，无死引用）；另有 2 个只按 basename 提及（`plugin-check.cjs`、`route-test.mjs`）。
- **24 个文件未被 HARNESS.md 登记**（按 basename 全文比对）：

| 未登记脚本 | AGENTS.md 是否提及 |
|---|---|
| `assistant-stream-check.cjs` | 有 |
| `image-check.cjs` | 有 |
| `mcp-injection-check.cjs` | 有 |
| `steer-check.cjs` | 有 |
| `catalog.mjs` | 有 |
| `probe.mjs` | 有 |
| `stream-probe.mjs` | 有 |
| `revert-check.mjs` | 有 |
| `revert-shape-probe.mjs` | 有 |
| `surface-check.mjs` | 有 |
| `file-snapshot-check.mjs` | 有 |
| `snapshot-lifecycle-check.mjs` | 有 |
| `file-mutation-gate-check.mjs` | 有 |
| `rewind-merge-check.mjs` | 有 |
| `rewind-e2e.mjs` | 有 |
| `rewind-merge-e2e.mjs` | 有 |
| `rewind-native-check.mjs` | 有 |
| `factory-ownership-order-check.mjs` | 有 |
| `replay-fidelity-probe.mjs` | 有 |
| `p003-approval-preflight.mjs` | **无** |
| `p003-bridge-check.mjs` | **无** |
| `p003-live-check.mjs` | **无** |
| `p003-live-support.mjs`（基础设施） | **无** |
| `p003-permission-check.cjs` | **无** |

> 准确计数：24 个未登记，其中 19 个在 AGENTS.md 有提及，5 个（p003 组）两处都没有索引。

**判定**：HARNESS.md 自称是「改到哪块该跑哪个检查」的逐脚本清单，新增脚本应登记在此；24 个缺口里 19 个靠 AGENTS.md 兜住，5 个 p003 相关脚本完全没有索引（`p003-permission-check.cjs` 与 `p003-bridge-check.mjs` 实际是可离线复跑的回归检查）。这不是实跑失败，但按项目规则属于清单维护缺口，建议 docs-consistency lane 收口。

**文件分类计数**：84 = 65 已执行 + 13 未执行 + 6 基础设施。

基础设施 6 个（不是独立检查）：`fake-dsh-bridge.mjs`（假 `dsh` 替身）、`plugin-build.cjs`（编译与新鲜度判据，由 `plugin-build-check.mjs` 覆盖）、`source-shape.cjs`（TSX 结构读取器）、`p003-live-support.mjs`（真实 profile 夹具）、`harness-gates.cjs` / `isolated-dsh-home.cjs`（共用判据与一次性 home，由 `harness-gates-check.mjs` 覆盖）。

## 3. 逐项结果

### 3.1 类型与契约门（4 项）

| 脚本/命令 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| TypeScript | `cd paseo-plugin && ./node_modules/.bin/tsc --noEmit` | 0 | 4.61s | 通过 | 无输出，项目自身 `tsconfig.json` 全量类型检查 |
| `dsh-api-contract-check.mjs` | `node harness/dsh-api-contract-check.mjs` | 0 | 0.10s | 通过 12/12 | DSH 0.2.1-rc.5；8 个包 loaded、0 failed；`EXPECTED` 双向覆盖 |
| `bridge-assets-check.mjs` | `node harness/bridge-assets-check.mjs` | 0 | 0.06s | 通过 2/2 | `bridge-assets.ts` 与 `dsh-bridge/`+`templates/` 的 21 个文件逐字节一致 |
| `plugin-build-check.mjs` | `node harness/plugin-build-check.mjs` | 0 | 7.72s | 通过 86/86 | 新鲜度/构建戳判据全部双向断言；scratch 在 `/tmp` 且已自动清理 |

### 3.2 纯模块直跑（26 项）

命令统一为 `node harness/<脚本>`（仓库根目录）。

| 脚本 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|
| `archived-lineage-check.mjs` | 0 | 0.05s | 12/12 | 桥归档血统与 `underArchivedSession` 逐字等价 |
| `bridge-entry-check.mjs` | 0 | 0.16s | 13/13 | `startBridge` 工具生命周期接线顺序（ticket→snapshot→commit） |
| `bridge-server-check.mjs` | 0 | 0.29s | 64/64 | 只读驱动真实 `server.js`（需本机 DSH 安装，无 profile/模型） |
| `doctor-check.mjs` | 0 | 0.62s | 37/37 | 真实 `runDoctor()` 跑沙箱 `DSH_HOME`，正反对照 |
| `fake-bridge-multi-check.mjs` | 0 | 1.03s | 23/23 | 假桥 `multi` 场景纯协议层 |
| `file-mutation-gate-check.mjs` | 0 | 0.14s | 6/6 | freeze 排空在飞写入、超时重开准入 |
| `file-snapshot-check.mjs` | 0 | 2.18s | 69 passed | journal/objects/rescue 与恢复计划（真实临时目录） |
| `frame-reader-check.mjs` | 0 | 8.63s | 32 passed | 20 MB 帧逐字节还原；旧实现 oracle + 耗时对照 |
| `harness-gates-check.mjs` | 0 | 3.93s | 41/41 | harness 自身判据回归（T01–T04、HP-05/08） |
| `image-host-path-check.mjs` | 0 | 0.24s | 46/46 | 图片块 `hostPath` 注入与 history 重放投影 |
| `local-patches-check.mjs` | 0 | 0.53s | 16/16 | `local-patches/` 真实 apply/check 脚本 + 临时 fixture |
| `mcp-gateway-call-check.mjs` | 0 | 0.46s | 17/17 | `mcp_call_tool` 结果投影与取消穿透（loopback） |
| `mcp-gateway-guard-check.mjs` | 0 | 0.34s | 70/70 | 网关 `tool` 参数守卫；被拒调用不到达 server |
| `mcp-gateway-transport-check.mjs` | 0 | 0.15s | 10/10 | `url`/`command` 排他判定与点名报错 |
| `mcp-http-check.mjs` | 0 | 5.15s | 60/60 | 桥的 MCP streamable-HTTP 客户端（loopback） |
| `mcp-stdio-check.mjs` | 0 | 2.00s | 28/28 | 桥的 MCP stdio 客户端：握手、非 JSON stdout、超时、退出 |
| `paseo-system-envelope-check.mjs` | 0 | 0.09s | 33/33 | `<paseo-system>` 信封两形翻译 |
| `probe-check.mjs` | 0 | 0.58s | 46/46 | probe 退出码与泄密防护 |
| `revert-shape-probe.mjs` | 0 | 0.08s | 10 passed | 用本机已装 `@deepseek-ai/dsh-session` 验证替换事件形状（只读模块） |
| `rewind-merge-check.mjs` | 0 | 0.09s | 54/54 | 父子文件快照归因、断链 fail-open |
| `rewind-transaction-check.mjs` | 0 | 0.71s | 17/17 | 撤回事务：计划时机、door、durability、files-only |
| `snapshot-lifecycle-check.mjs` | 0 | 0.09s | 8/8 | 捕获序号跨重启续数、旧 journal 歧义拒绝 |
| `surface-check.mjs` | 0 | 0.04s | 18 passed | 重放折叠：只折本桥撤回缝、compaction 不折 |
| `transport-frame-check.mjs` | 0 | 7.31s | 26 passed | 入站分帧 20 MB 帧；旧实现 oracle + 耗时对照 |
| `p003-bridge-check.mjs` | 0 | 0.28s | 10 项 | 真实桥模块 + recording transport，无 profile/模型 |
| `factory-ownership-order-check.mjs` | 0 | 0.48s | 6/6 | `beginOwner` 接在真实 DSH agent factory 的 `setup` 上（需本机 DSH 安装） |

### 3.3 自编译组（16 项）

脚本内部经 `plugin-build.cjs` 编译到各自的 `paseo-plugin/.dbg-*`；命令统一为 `node harness/<脚本>`。

| 脚本 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|
| `bootstrap-check.mjs` | 0 | 0.81s | 16 passed | 桥安装 verify-before-switch、失败日志不谎报 ready |
| `catalog-cache-check.mjs` | 0 | 1.40s | 2 passed | 按 cwd 的 LRU：A→B→A 恰好 2 个 probe（数真实收到 `paseo/catalog` 的进程） |
| `child-crash-check.mjs` | 0 | 5.91s | 14/14 | 子代理回合中 SIGKILL 共享子进程：子先于根收到点名 `runtime_failed` |
| `concurrent-open-check.mjs` | 0 | 1.95s | 15/15 | 并发 `session.open` 事务守卫两窗口 + 重新 open 成功 |
| `context-usage-check.cjs` | 0 | 15.43s | 15 项 PASS | 真实 `DshSession` 只替换进程传输：用量上报边界、缓存补发 |
| `host-contract-sim.mjs` | 0 | 0.46s | 7/7 | **仅当前已装 patched 宿主**（`truncates history on rewind (patched)`）；stock 半场未跑（§5） |
| `multi-session-check.mjs` | 0 | 14.74s | 40/40 | 两 Paseo 会话共用一个 `dsh` 子进程：不串台、引用计数、孤儿帧清理 |
| `open-degrade-check.mjs` | 0 | 9.91s | 8 passed | open 期降级必须发 `session.notice`/warning 而非只写 stderr |
| `p003-permission-check.cjs` | 0 | 5.26s | 6 项 | 真实 `DshProcess`/`DshSession` + 脚本化 stdio peer |
| `p003-timeline-check.cjs` | 0 | 0.42s | 8 项 | 真实 `TimelineBuilder` → `ProviderEventSchema` → 客户端数据 |
| `process-crash-check.mjs` | 0 | 4.21s | 13/13 | 大帧写死子进程：无 uncaughtException、请求立刻失败且可见 |
| `replay-turn-check.cjs` | 0 | 4.11s | 8 项 | 重放成对 `session.turn`；撤回回合不发；信封行归属正确 |
| `revert-check.mjs` | 0 | 0.86s | 120 passed | 撤回目标判定、可见 surface 范围、共享进程接线 |
| `rewind-notice-check.cjs` | 0 | 0.37s | 63/63 | 撤回完成提示文案/计数回退、一次性胶囊、目录观察、接线 |
| `rewind-notice-delivery-check.mjs` | 0 | 12.19s | 30/30 | 真实宿主 registry/AgentManager + 假 Paseo API：报告确定性落时间线、canary 仍先于回执、慢宿主与降级路径 |
| `session-state-check.cjs` | 0 | 0.42s | 25/25 | 会话状态机：回合统计 reset、`configure` 回执回读、modes 单源、子会话闸门 |

### 3.4 手工编译组（19 项）

统一编译树 `paseo-plugin/.dbg-verify-1103`（本轮由 `plugin-build.cjs` 全量构建，构建后 `freshness()` 为 FRESH）；命令为 `cd paseo-plugin/.dbg-verify-1103 && node <脚本>`。

| 脚本 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|
| `agent-message-check.cjs` | 0 | 0.06s | 111 passed | `agent_message` 行映射与英文标签对齐官方 display model |
| `assistant-retry-check.cjs` | 0 | 0.76s | 8/8 | 同 step 重试：两 attempt 不同 id、durable 落在第二个 |
| `assistant-stream-check.cjs` | 0 | 0.77s | 7/7 | 增长快照同 id、`id === messageId`、折叠后一行 |
| `image-check.cjs` | 0 | 1.01s | 8/8 | 带 `hostPath` 图片块恰好一条 markdown `assistant_message` |
| `jobs-poll-check.cjs` | 0 | 0.17s | 100/100 | 轮询状态机：可见性、间隔/退避、分页、终态错误停轮询 |
| `jobs-popover-check.cjs` | 0 | 0.38s | 218/218 | 几何/状态标记/JSX 接线/宿主主题；`HOST_APP=<paseo checkout>` 已提供 |
| `locale-check.cjs` | 0 | 0.06s | 269 passed | locale 解析链与中英标签表覆盖 |
| `mcp-injection-check.cjs` | 0 | 6.63s | 40/40 | per-session `paseo/mcp/set` 帧、gateway/stdin 白名单、sse 拒绝 |
| `newest-check.cjs` | 0 | 0.23s | 36 passed | 最新行/脉冲判定：位置、提交批次、窗口、交接、时钟 |
| `session-request-check.cjs` | 0 | 0.81s | 52/52 | sessions 导入列表与撤回回执；canary 恰好一条且在回执前；完成报告在回执后 |
| `steer-check.cjs` | 0 | 1.96s | 25/25 | 插话回执与 `activeForegroundTurnId` 匹配；未取消子代理 |
| `style-check.cjs` | 0 | 0.07s | 254 passed | `client/tokens.ts` 共享样式常量表 |
| `subagent-check.cjs` | 0 | 25.67s | 90/90 | 子会话可见性、归档往返/replay 过滤、拒绝必须 `request.failed` |
| `sweep-check.cjs` | 0 | 0.04s | 25 passed | 扫光几何：停点、阶梯 alpha、`steps(48)` |
| `thinking-check.cjs` | 0 | 0.05s | 51 passed | 思考行折叠预览首行规则与宽度接线 |
| `timeline-check.cjs` | 0 | 0.19s | 208 passed | 工具行状态机、meta 透传、detail 分支 |
| `tool-call-check.cjs` | 0 | 0.06s | 365 passed | 工具行映射：图标/命令/diff/截断、失败原因、终端卡 |
| `uploaded-file-check.cjs` | 0 | 0.17s | 17/17 | 附件块翻译与官方 `renderPromptAttachmentAsText` 逐字一致 |
| `plugin-check.cjs --self-test` | 0 | 0.22s | 4/4 + self-test passed | **只跑离线半场**：编译产物加载 + 图片块翻译；真实回合半场未跑（§5） |

> 与 `docs/audits/20261102/verify-runner.md` 相比，多个脚本断言数明显上升（如 `bridge-server` 34→64、`doctor` 29→37、`file-snapshot` 56→69、`jobs-poll` 33→100、`session-request` 21→52、`tool-call` 336→365、`rewind-notice-delivery` 新增 30），说明修复轮新增判据已进入本轮执行且全部通过。

### 3.5 额外探针（1 项，只读真实会话日志）

| 脚本 | 命令 | exit | 耗时 | 结果 | 备注 |
|---|---|---|---|---|---|
| `replay-fidelity-probe.mjs` | `node harness/replay-fidelity-probe.mjs` | 0 | 0.13s | 4 passed | 自动选 `$DSH_HOME/sessions` 下最新日志（490 events，read-only）：无本桥撤回标记时逐字重放 490/490；撤回缝用脚本内合成事件断言 |

## 4. 失败项详情

**无失败项。** 66 项 exit code 全为 0，日志中无 `FAIL` 断言行（4 个日志出现 "FAIL" 字样，均为 PASS 行内引用的负向对照证据：`harness-gates-check` 的 FAILS 终态分类、`local-patches-check` 的 `FAILED — host-fields-changed` 报错文本、`session-request-check` 的 `PLAN-FAILED` 夹具、`probe-check` 的 `FAILED (401)` 基线）。未做任何重试。

## 5. 未执行清单与原因（13 项）

| 脚本 | 未执行原因 |
|---|---|
| `plugin-check.cjs`（完整） | 非纯离线：不设 `DSH_BINARY` 时会起真实 `dsh --profile` 跑真实模型回合（耗 token）；本轮只跑 `--self-test` 离线半场 |
| `route-test.mjs` | 逐条路由跑真实回合（耗 token） |
| `probe.mjs` | 端到端真实模型提问往返（耗 token） |
| `tools.mjs` | 真实 `dsh` 的最小回合工具目录转储（起真实 dsh） |
| `stream-probe.mjs` | 真实 `dsh --profile` 的流式端到端（耗 token） |
| `rewind-e2e.mjs` | 真实 `dsh --profile paseo`、3 回合端到端（耗 token） |
| `rewind-merge-e2e.mjs` | 真实模型父子归并端到端（耗 token） |
| `rewind-native-check.mjs` | 需**打过补丁且正在运行**的 daemon，经真实 daemon 的撤回（耗 token） |
| `archive-registry-check.mjs` | 需真实 `dsh --profile`，把 `paseo/archive` 作为第一帧发给真 registry（碰真实 profile 装载路径） |
| `subagent-live.mjs` | 脚本明确要求主会话手工跑：真实模型回合 + 真实子代理 |
| `p003-live-check.mjs` | 真实插件 + 真实 DSH + 已配置模型，会产出可丢弃的 profile/session（耗 token） |
| `p003-approval-preflight.mjs` | 真实 DSH 服务 + 模型调用工具（审批路径，耗 token） |
| `catalog.mjs` | 会拉起真实 `dsh --profile paseo` 并读真实 profile（虽不跑回合，仍超出「不碰真实 profile」边界） |
| `session-calls.mjs` | **诊断工具不是回归**：读 `$DSH_HOME/sessions` 做 schema diff，无通过/失败判据 |

覆盖差异补充：

1. **`host-contract-sim.mjs` 只跑了一半**：本次运行的是当前已装 **patched 宿主**（`truncates history on rewind (patched)`），7/7 只证明 patched 行为；stock 半场需要 `npm pack @getpaseo/server` 解包 + 手工 wrapper 目录，本轮未做（不装包约束）。
2. **`plugin-check.cjs` 的真实回合半场未跑**：这是发布前唯一能证明真实 provider/凭据/路由/提示词装配的检查，本轮只证明编译产物可加载与图片块翻译。
3. **`replay-fidelity-probe.mjs` 的实例数据**：选中的真实日志没有本桥撤回标记（`rewind markers: 0`），撤回缝只由脚本内合成事件覆盖。
4. **手工编译组**为满足「产物必须在 `paseo-plugin/` 下」的硬约束，统一用一棵 `.dbg-verify-1103` 树顺序运行（未按每脚本各自的 `.dbg-*` 名各建一棵）；该目录在 `.gitignore` 的 `.dbg-*/` 规则内，未入库。
5. 编译期 tsc 类型错误是这些脚本头部声明的预期现象（`--moduleResolution node` 下），不算失败；产物已由 `freshness()` 复核为当前源码的新鲜构建。

## 6. 结论：全绿能当什么、不能当什么

**计数：通过 66 / 失败 0 / 跳过 13（另 `plugin-check` 半场、`host-contract-sim` stock 半场未覆盖）；基础设施文件 6 个不计检查。**

**能证明（当前 HEAD 的离线回归面）：**

- `paseo-plugin` 源码在项目自身 `tsconfig.json` 下 `tsc --noEmit` 0 错误。
- 桥对 DSH 0.2.1-rc.5 内部组装包的依赖仍成立（8 包、12 符号、双向覆盖）；内嵌桥资产与源码 21 文件逐字节一致；`plugin-build.cjs` 新鲜度判据 86 场景双向成立。
- 65 个 harness 脚本各自断言范围内通过：桥的撤回/文件快照/分帧/MCP/归档血统、插件会话状态机/多会话隔离/崩溃失败通道/重放折叠、客户端数据层（时间线、工具行、思考、locale、jobs、脉冲、扫光）、doctor/probe 判定、撤回完成提示的文案与确定性投递等。
- 修复轮新增的判据（撤回提示两条链、会话状态机、open 降级、catalog LRU、bootstrap、local-patches、bridge-entry、MCP 网关调用契约等）在当前 HEAD 全部可复跑通过。

**不能证明（发布判据缺口）：**

- **真实模型回合**：`plugin-check.cjs` 全量、`route-test`、`probe`、`stream-probe`、`rewind-e2e`/`rewind-merge-e2e`、`p003-live-check`、`p003-approval-preflight` 均未跑；真实 provider/凭据/路由/模型、空模型目录、提示词装配失败（FIELD-NOTES #58 类）不在覆盖内。
- **真实 daemon 与补丁宿主端到端**：`rewind-native-check` 未跑；`host-contract-sim` 只覆盖 patched 宿主，stock 宿主行为未验证。
- **真实 profile 装载路径**：`archive-registry-check`、`catalog.mjs` 未跑，`paseo/archive` 在真实 registry 上是否可达、live profile 是否装载新桥未验证。
- **设备 UI**：iOS/Android/React Native 渲染、脉冲、布局、扫光均未在真机验证。
- **其它 DSH 版本**：只对已装 0.2.1-rc.5 验证；alpha 或未来 rc 的内部符号/语义变化不在覆盖内。
- **脚本判据本身的完备性**：本轮只执行脚本，不评判断言是否足以抓住目标缺陷（属 harness 审查 lane 范围）。

**「全绿」能否当发布判据：不能。** 本轮全绿只说明「离线/假桥回归面在当前 HEAD 无回归」。按 AGENTS.md 的发布流程，发布前至少还需补跑：`plugin-check.cjs` 全量（真实模型回合，含 doctor 基线）、`route-test`/`probe`（路由与端到端）、动了流式时的 `stream-probe`、动了撤回时的 `rewind-e2e` 与 `rewind-native-check`（真 daemon + 补丁宿主）、动了归档/桥入口时的 `archive-registry-check`，以及用户真机验收。这些都需要真实环境/授权，不在本轮只读实跑范围内。
