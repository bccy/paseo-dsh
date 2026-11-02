# 服务端 S01–S08 修复核查（fix-verify-server）

- 核查对象：`2f71225`（main，工作区干净；唯一未跟踪项为本轮审查目录 `docs/audits/20261102/`）
- 对照基线：`9298c28` 的 [FULL-AUDIT-20261031 §3.2](../../FULL-AUDIT-20261031.md) 与 [audits/20261031/server.md](../20261031/server.md)
- 环境：DSH 0.2.1-rc.5、`@getpaseo/cli` / `@getpaseo/server` / `@getpaseo/plugin` 均 0.14.0、Node v22.23.1
- 方法：`git diff 9298c28..HEAD` 全量读；逐条追当前源码调用链；用 `git archive 2f71225` 的隔离副本重跑上一轮归档复现（不写 live profile、不调模型、不启 daemon）；跑现有 harness 回归；对宿主与 Paseo CLI 的消费点按已安装 0.14.0 包核对。
- 证据分级：**实测** = 本机命令跑出；**静态** = 源码/安装包读取；**未验证** = 明确未执行。

## 一、逐条结论

| ID | 级别 | 当前状态 | 证据（file:line） | 回归结果 | 残余风险 |
|---|---|---|---|---|---|
| S01 | P1 | **已修复** | `provider.ts:1130-1157` 在第一个 await 前同步 claim 双身份（native id + provider id）；`:1177-1187` `#assertOpening` 复核 claim/`#sessions` 身份；`:983-1002` `session.close` 置位 in-flight open 为失效；`:1200-1204`、`:1243-1266`、`:1332-1334`、`:1509-1515` 每个 await 后复核；`:1546-1573` 发布 opened/config/ready 前后复核，ready 后重入 close 静默退出；`:477-489` 失败统一成 `request.failed` | `node harness/concurrent-open-check.mjs` → exit 0，**14/14 PASS**（含 (a) close-during-open 使 open 响亮失败且不发布 ready、(b) 同 provider id 重绑定被拒且只发布一次 ready）。反向对照：归档旧复现 `server-race-wire.cjs` 在 HEAD 上 exit 1，恰好断在 `assert(... runtime_failed ... 'unknown session')`（`probes/server-race-wire.cjs:25`），即旧症状不再出现，而其前置断言（第二 open `request.failed`、第一 open `session.ready`、sibling 可用）均通过 | ① 第二个并发 open 现在被设计性拒绝（`provider.ts:1124-1128`），与基线"两者都尝试"不同，属预期语义变化，正常串行重开已由检查第 5 项验证；② `session.opened` 事件处理器内**重入** `session.close` 的发布中止路径只有代码防护，无独立回归用例（未验证） |
| S02 | P2 | **未修复** | catalog 侧：`provider.ts:285-287` 按 `planMode === false` 过滤、`:310` 作为 `defaults.modes`；session 侧：`session.ts:675` 无条件 `modes: modes()`，`session.ts:92-96` 恒返回 build+plan；`DshSession` 构造参数（`provider.ts:1335-1407`）没有接收过滤后的 modes；宿主确实消费：`@getpaseo/server@0.14.0` `plugin-provider.js:1197-1204` 把 `event.config.modes` 发布为 `availableModes` | 动态（编译产物 `.dbg-t6`）构造真实 `DshSession` 后 `configState().modes` = `[build, plan]`；provider 侧 catalog 只在 `defaults.modes` 过滤，两条数据源仍分裂 | profile 关闭 plan-mode 时，draft 阶段消失的 Plan 在会话打开后重现；显式选择仍失败（与基线一致） |
| S03 | P2 | **未修复** | `session.ts:1629-1632` 先把 `#mode` 提交成新值再 `await process.setPlan()`；同类写序 `session.ts:1616-1621`（`#thinkingOption` 先提交再 `await process.setConfig()`） | 归档复现 `run.py --case server-config --ref 2f71225` → 脚本 **exit 0（=缺陷仍复现）**；日志 `REJECTED_PLAN {"backend":false,"advertised":"plan"}`（setPlan 被拒后本地 mode 仍是 plan），另有成功路径对照通过 | 失败后下一次 `session.config` 继续发布未提交值；多字段部分成功仍未回读真实状态 |
| S04 | P2 | **未修复** | `session.ts:1589-1601` 只换模型时仅更新 `#route`；`#thinkingOption` 只在 `changes.thinkingOption` 分支（`:1603-1627`）更新；`configState` 仍发旧值（`:669-676`，字段在 `:673`） | 同一归档复现 **exit 0**；日志 `STALE_EFFORT {"backend":null,"advertised":"high","options":[]}`（后端 effort 已清空，advertised 仍 high） | 界面/runtimeInfo 与实际模型请求不一致，且可能被带入后续配置/重开 |
| S05 | P2 | **未修复** | `session.ts:1528-1535` 在发 prompt 前预置 `#turnId`（调用点 `:1367`、`:1421`）；`session.ts:1798-1804` 仅在 `#turnId === null` 时清工具计数；统计在 `:2286-2293`、`:2347` 继续累计 | 归档复现 `run.py --case server-lifecycle --ref 2f71225` → **exit 0**；日志 `SECOND_TURN_TOOL_COUNT 2`（两个各含 1 次工具的回合，第二回合报 2） | 工具次数/耗时失真；新回合首条 assistant/message 前的迟到 usage 仍可能改上一回合 lastStats |
| S06 | P2 | **未修复** | `session.ts:544-561` 进程退出时对**所有**已见 child 调 `child.fail()`，无终态判断；`session.ts:2817-2826` `fail()` 无条件发 `session.runtime_failed`；宿主无条件 upsert 为 failed：`@getpaseo/server@0.14.0` `plugin-provider.js:1270-1277` | 同一归档复现 **exit 0**；日志 `COMPLETED_CHILD_AFTER_PROCESS_EXIT` 依次为 `turn started` → `turn completed` → `runtime_failed` | 共享进程退出会把已完成的历史子代理卡片改写成 failed（覆盖真实历史终态） |
| S07 | P3 | **未修复** | 直接路径有 label 等待条件（`session.ts:2002-2009`，含 `#labelWaitExceeded`），flush 路径只检查 rootReady/父可解析（`session.ts:2099-2120`，判据在 `:2112`）；已打开 child 不再更新 title（`:1997` 直接 return） | 同一归档复现 **exit 0**；日志 `UNRELATED_CHILD_RELEASES_UNTITLED {"type":"session.opened","sessionId":"root:sub:without-title",...}`（无 title 即被打开） | 并行子代理时可能出现永久无标题/加载中，descriptor 晚到也无法更正 |
| S08 | P2 | **未修复（静态闭环）** | env 只在首次 spawn 定死：`provider.ts:602-647`（`env: options.env`）、`provider.ts:551-558` 注释自述无 per-session 通道、`:705-712` 明确跳过 `PASEO_AGENT_ID`/`PASEO_AGENT_CWD` 的差异告警；`DshSessionOptions` 无 env 字段：`dsh-process.ts:411-419`；子进程 env 在 spawn 处合并成进程级：`dsh-process.ts:1412-1418`；DSH 侧 `@deepseek-ai/dsh-subprocess/lib/index.js:50-55` 的 `scrubbedParentEnv()` 只删敏感键与 `DSH_*`，保留 `PASEO_AGENT_ID`；Paseo CLI 0.14.0 仍读 ambient 身份：`dist/commands/heartbeat/index.js:15`、`dist/commands/schedule/shared.js:94`、`dist/commands/agent/send.js:143`、`dist/utils/caller-agent.js:5` | **未执行**（会创建 heartbeat/发送消息，属副作用探针；按上一轮门禁用静态闭环）。静态核对与 20261031 结论逐项一致，且当前代码自 9298c28 未改该路径 | 会话 B 加入由 A 打开的池后，B 经 shell 调依赖默认调用者的 Paseo CLI 仍可能把 A 当 self/source；MCP 路径身份独立，不受影响 |

## 二、回归执行记录

| # | 命令 | 结果 | 能证明什么 |
|---|---|---|---|
| 1 | `node harness/concurrent-open-check.mjs` | **exit 0，14/14 PASS**（现场编译到 `paseo-plugin/.dbg-t6`） | S01 修复成立：单 ready、失败方响亮报错且被 in-flight 守卫拦下、胜者 prompt 有回答无 "unknown session"、claim 释放后可串行重开；part 2 的 close-mid-open 与 provider-id 重绑定窗口同样通过 |
| 2 | `node harness/context-usage-check.cjs paseo-plugin/.dbg-t6` | **exit 0，15/15 PASS** | 附带覆盖 `cedeaf3`（usage 补发/不可用不清值/迟到响应/关闭清理），**不属 S01–S08 判定** |
| 3 | `python3 docs/audits/20261031/reproductions/run.py --case server-config --ref 2f71225` | 脚本 **exit 0**（该脚本 exit 0 = 历史反例仍复现）；输出 `STALE_EFFORT` / `REJECTED_PLAN` 见上表 | S03、S04 未修复 |
| 4 | `python3 .../run.py --case server-lifecycle --ref 2f71225` | 脚本 **exit 0**；输出 `SECOND_TURN_TOOL_COUNT 2`、`UNRELATED_CHILD_RELEASES_UNTITLED`、`COMPLETED_CHILD_AFTER_PROCESS_EXIT` | S05、S06、S07 未修复 |
| 5 | `python3 .../run.py --case server-open --ref 2f71225` | 脚本 **exit 1**，断言失败的正是 `server-race-wire.cjs:25`（要求出现 "unknown session" 的 `runtime_failed`） | S01 旧的用户可见症状在 HEAD 不再出现（与 #1 互证） |
| 6 | 副本来源校验 | 上述隔离副本的编译产物中含 HEAD 独有标记：`another open for this provider session is already in flight`（provider.js 1 处）、`publishUsageAfterOpen`（session.js 3 处） | 复现跑的是 `2f71225` 源码，不是 `9298c28` 基线 |

补充说明：run.py 的 `--ref 2f71225` 走 `git archive` 到 `/tmp` 私有副本 + 软链现有 `paseo-plugin/node_modules`，使用一次性 `DSH_HOME`/`PASEO_HOME`，不触达 live profile、daemon 或模型。归档脚本头注释明确"exit 0 表示缺陷仍复现，不是修复通过"，因此 #3/#4 的 exit 0 是"未修复"的证据。

## 三、发现清单（本次新发现）

- **无本次新引入缺陷**：S01 补丁（`de4ba8c`）未发现新问题；`cedeaf3` 的 usage 改动经 #2 全绿，也不属本组条目。S02–S08 均为合并前既有问题、当前 HEAD 未修，不计作本次引入。
- 观察项 **N1 / P3 / 未验证**：`provider.ts:1564-1573` 针对 `session.opened` 处理器内重入 `session.close` 的发布中止（断言 + ready 后静默 return）只有代码防护；现有 `concurrent-open-check` 覆盖的是 holder close 窗口与 provider-id 重绑定，未构造"发布中途重入 close"的独立用例。若宿主在该回调里同步关闭，事件序列会是 `session.opened → session.closed → request.failed`，是否正确应由客户端/宿主侧断言钉住。
- 观察项 **N2 / P3 / 设计确认，非缺陷**：S01 修复后同一 DSH session 的第二个并发 open 一律 `request.failed`（`provider.ts:1124-1128` 已写明这是 callers bug 的响亮拒绝）。Paseo 的重试/刷新策略若把它当可重试失败需另行确认；正常串行 reload 路径已由 #1 第 5 项覆盖。
- 未验证项：S08 动态探针（副作用）；S01 的 session.opened 重入路径；真实 daemon/真机（本轮只读，未启动）。
- 残留临时产物：`paseo-plugin/.dbg-t6`（harness 自行编译的 gitignored 构建目录）与 `/tmp/paseo-audit-20261031-*` 证据目录，可随时删除。

## 四、总评

**S01 已真正修复且回归可信（14/14 + 旧反例反向对照），S02–S08 七项全部未修、现状与 20261031 基线一致；本批提交只修了 S01 与不属本组的 usage 补发，其余七项需要另立修复任务。**
