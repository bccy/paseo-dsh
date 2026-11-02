# 全量代码健康度审查（2026-11-02）

- 审查基线：`2f71225`（main，工作区干净）
- 上一轮全量审查：[FULL-AUDIT-20261031](./FULL-AUDIT-20261031.md)，基线 `9298c28`
- 环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node v22.23.1
- 分工：21 个只读审查 lane（生产代码 14 路 + 测试体系 2 路 + 修复核查 2 路 + 文档/执行/横切 3 路），
  分区报告与证据索引见 [audits/20261102](audits/20261102/README.md)
- 本次只交付审查与证据：未修改任何产品代码、未 git 写操作、未跑真实模型/daemon、
  未写真实 `~/.dsh` profile、未安装依赖、未发布

## 1. 结论

**代码健康度中等偏上（全仓约 3.2/5），没有 P0/P1 阻断性缺陷，但“全绿”之下压着 30+ 条 P2。**
当前 HEAD 可发布、可使用，失败语义与协议实现整体比同类集成项目扎实；真正的问题是**历史欠账的修复率**：
上一轮登记的 25 条问题里只有 3 条（全部是 P1）修掉了，其余 22 条原样存在。

四个最重要的判断：

1. **修复核查：3 修 18 未修。** `S01`（并发 open 毁会话）、`BR-01`（快照序号跨重启）、
   `BR-02`（撤回漏掉在飞子任务写入）三条 P1 在 `de4ba8c`/`2f71225` 确已修复，反例翻转 + 新回归双证。
   其余 `S02–S08`、`BR-03–08`、`C1/C2`、`D1/D2`、`L1`、`T01–T04` 全部未修，源文件在基线后 0 改动，
   原始反例在当前 HEAD 逐条仍复现。
2. **新引入的 P2 也要认账。** `9298c28..HEAD` 的 +7002 行里，至少 6 条新缺陷：
   `fileMutationTickets` 不随会话关闭清理（三路独立确认，会让后续撤回冻结 15s 失败）、
   撤回对所有 scope 强依赖 DSH 内部 `agent.runMaintenance`、闸门与 `waitForChildren` 互等到 3s、
   conversation-only 撤回也无条件拿文件闸门、jobs 功能 4 条 P2（含「完成分组永远不可达」）、
   CI 冲突清单漏 4 个自动门。
3. **测试体系“绿”不等于“对”。** 56/56 离线检查全过、tsc/契约/内嵌桥全绿；但两个真实环境主门
   （`plugin-check`、`route-test`）仍带上一轮 T01–T04 的假绿判据，真实 profile/模型脚本无
   `DSH_HOME` 隔离，19 个脚本手工编译到共享 `.dbg*` 树 —— 「全绿」不能直接当发布判据。
4. **文档的“当前事实”在漂移。** 版本声明三处矛盾（README 写 0.2.11、package.json 0.2.16、
   npm latest 0.2.17）、ADOPTION 仍写「桥每会话新起」、OVERVIEW 仍写「本地图片不显示」。

按上次审查的定级口径（P1 会话可用性/恢复正确性，P2 功能/数据/契约，P3 显示/可维护性），
本轮**没有新增 P1**；既有 P2 里，会话竞态类（`PP-01`、`CORE-03`）与撤回一致性类（`RW-01`、
`BR-03`、`BR-04`）最值得先修。

## 2. 范围与方法

21 个独立只读 lane，每个 lane 一个共享任务、一份分区报告；全部 fresh context、只读运行。
分区与文件归属见 [audits/20261102/README.md](audits/20261102/README.md) 的 Lane 索引。

| 区域 | lane | 代表文件/范围 |
|---|---|---|
| 桥（约 8.1k 行） | bridge-server-core / bridge-server-rewind / bridge-files / bridge-mcp / bridge-misc | `dsh-bridge/lib/` 19 个模块 |
| 插件服务端（约 17k 行） | plugin-session / plugin-provider / plugin-process / plugin-timeline | `paseo-plugin/server/` 全部 |
| 客户端（约 7.3k 行） | client-toolcall / client-jobs / client-misc | `paseo-plugin/client/` + `shared/` |
| 可选宿主补丁（约 4k 行） | local-patches | `local-patches/` 全部 |
| 交付层 | delivery | doctor/probe/bin/scripts/manifest/CI/入口 |
| 测试体系（约 30k 行） | harness-bridge / harness-plugin | `harness/` 72 个脚本 |
| 修复核查 | fix-verify-server / fix-verify-bridge-client | 上轮 S01–S08、BR/C/D/L/T 逐条 |
| 横切 | health-crosscut / docs-consistency / verify-runner | 全仓模式、13 份文档、全量离线执行 |

证据纪律：每条发现带 `file:line`、触发条件、证据等级（实测/源码推断/文档）与归属
（新引入 vs 基线已有）。标「实测」的条目由 lane 用编译产物、假桥、loopback 或合成状态探针复现；
修复核查要求在**当前 HEAD 副本**上复跑原始反例并记录 exit code，不采信提交信息。
未执行的层（真实模型回合、真实 daemon 撤回、真机 UI、压力/内存）在分区报告里逐项列为未验证。

## 3. 上一轮问题修复核查

### 3.1 已修复（3 条，全部 P1）

| ID | 级别 | 状态 | 关键证据 |
|---|---|---|---|
| S01 | P1 | 已修复 | `provider.ts:1130-1157` 双身份 claim 在第一个 await 前同步占位；`:983-1002` close 使在飞 open 失效；`:1546-1573` 发布前后复核。`concurrent-open-check` 14/14 PASS；旧复现 `server-race-wire.cjs` 在 HEAD exit 1（断在旧症状断言） |
| BR-01 | P1 | 已修复 | `file-snapshots.js:312-381,496-499,583-653` 捕获序号从 journal 高水位续数 + 旧行歧义 fail-closed；`snapshot-lifecycle-check` 8/8；原始反例断言 `actual='ORIGINAL'`，缺陷值不再出现 |
| BR-02 | P1 | 已修复 | `server.js:2396-2537` gate.freeze → append+flush → 取消并等待子任务 → flush 后重算 plan → restore 后按 failed/skipped 决定 prune；`rewind-transaction-check` 7/7、`file-mutation-gate-check` 6/6 |

修复质量复核：三条均未发现正常路径新回归。BR-02 仍有内建边界——`settleDelegatedWork` 只等 3s
（`server.js:2312-2326`），超时后继续恢复，3s 后仍存活的 child 写入属「恢复之后又写」；
另有极窄 `post-execute`→`commitFileTool` 窗口标「未验证」。

### 3.2 未修复（18 条，原样存在）

| ID | 级别 | 当前状态（证据） |
|---|---|---|
| S02 | P2 | catalog 隐藏 Plan（`provider.ts:285-287`）但 `session.config` 恒报 build+plan（`session.ts:675`），宿主发布为 availableModes；动态验证 `modes=[build,plan]` |
| S03 | P2 | 配置先提交后 await（`session.ts:1629-1632`/`:1616-1621`）；复现 `REJECTED_PLAN backend=false, advertised=plan` |
| S04 | P2 | 切模型只更新 route、不清 `#thinkingOption`（`session.ts:1589-1601`）；复现 `STALE_EFFORT backend=null, advertised=high` |
| S05 | P2 | 预置 `#turnId` 使统计 reset 不执行（`session.ts:1528-1535`/`:1798-1804`）；复现第二回合 `toolCalls=2` |
| S06 | P2 | 进程退出对已完成 child 仍发 `runtime_failed`（`session.ts:544-570`/`:2817-2826`），宿主覆盖为 failed |
| S07 | P3 | flush 路径缺 label 条件（`session.ts:2092-2120`），无标题 child 提前打开且不可更正 |
| S08 | P2 | 共享子进程 env 由首会话定死（`provider.ts:602-618`/`:705-719`），`PASEO_AGENT_ID` 差异被显式跳过；静态闭环，未跑副作用探针 |
| BR-03 | P2 | 孙任务仍锚到「执行时根最新人类消息」（`server.js:1872-1889`）；复现锚 20 而非 10 |
| BR-04 | P2 | 恢复只 lstat 末端、跟随祖先 symlink（`file-snapshots.js:669-702`）；实测把 outside 文件写成 ORIGINAL 且报 restored=1 |
| BR-05 | P2 | queued plan=false 被丢弃（`server.js:3606-3614`）；复现 `setCalls=[]`，重开后仍 plan |
| BR-06 | P2 | MCP `exec.signal` 不贯穿（`mcp-gateway.js:547-550` 等）；实测 abort 后仍 250ms 后成功返回 |
| BR-07 | P2 | `structuredContent` 丢失（`mcp-gateway.js:543/567`）；实测 `{answer:42}` → `content:""` |
| BR-08 | P2 | 图片 staging/target 可预测且不校验归属（`image-host-path.js:85-88,120-142`）；实测写穿 victim |
| C1 | P2 | 工具失败原因在 mapper 边界丢失（`tool-call-data.ts:1231/1259/1467-1499`），范围扩大到所有 failed 行 |
| C2 | P2 | 思考末帧增长+complete 同帧不落定（`inline-thinking.tsx:56-68`）；探针实测 |
| D1 | P2 | doctor 语义校验仍按 regex（`doctor.mjs:442-510`），7 类畸形配置全绿（实测） |
| D2 | P2 | probe 把 401/402/403 当能力拒绝并 exit 0 给永久改配置建议（`probe-provider.mjs:144-148` 实测） |
| L1 | P2 | 补丁 stale 重建替换 `bridge.revert(...)` 到闭括号之间整段，会删无关 tail（`apply-rewind-history-truncation.mjs:1332-1395`，纯内存复现） |
| T01 | P2 | route-test 有 partial 文本即 WORKS、全 FAIL 仍 exit 0（`route-test.mjs:118/135-139`） |
| T02 | P2 | tools.mjs initialize 不带 sessionId、prompt 带，真桥必拒（`tools.mjs:73-77`） |
| T03 | P2 | plugin-check 先过滤非 assistant 行再验邻接（`plugin-check.cjs:469-479`） |
| T04 | P2 | plugin-check 用 prompt 自带的 `IMAGE-SEEN` 当图像证据（`:359/494-508`） |

（`T01–T04` 为测试判据问题，`D1/D2` 为交付诊断问题，其余为产品正确性问题。）

## 4. 本轮新发现（按区域，均带分区报告细节）

### 4.1 新引入（`9298c28..HEAD` 的改动引入）

| ID | 级别 | 位置 | 摘要 |
|---|---|---|---|
| RW-01 / CORE-05 | P2 | `server.js:357,2086-2142` vs `:3325-3358` | `fileMutationTickets` 不在 `#forgetSessionState` 清理清单：close 时若有一次 tracked 写入尚未释放票据，票据永久残留、gate 租约常驻，该 root 之后的撤回 `freeze` 必等满 15s 失败。三路 lane 独立确认（重写 lane 的探针实测 tickets=1） |
| RW-02 | P2 | `server.js:2393-2396` | 撤回对所有 scope（含 `conversation`）强依赖 DSH 内部 `agent.runMaintenance` 且位于 `restoresFiles` 判断之前；该 API 无契约门，升级即全体撤回不可用 |
| RW-04 | P3 | `server.js:2397`、`:2473-2474`、`:2312-2326` | 闸门 × `waitForChildren` 互等：被保留的在飞子代理写入让每次撤回确定性多等满 3s 并打误导日志 |
| BF-04 | P3 | `server.js:2397` vs `:2406` | conversation-only 撤回也无条件先拿文件闸门，可被慢写拖到 15s 失败（无正确性需要） |
| CJ-01 | P2 | `jobs-pill.tsx:562-568,447-455,463` | pill 只在 live>0 可见 → 「已完成」分组/表头/「都已结束」在单任务场景永远不可达；DSH 自身此时仍显示数量 |
| CJ-02 | P2 | `jobs-pill.tsx:64,718-725,757-774` | 每个非 closed agent 一个 4s 定时器，隐藏时仍全速、同 tick 齐发、多客户端相乘、无退避 |
| CJ-03 | P2 | `jobs-pill.tsx:757-774` | 首个 snapshot 忽略 `pageInfo`，>200 agent 时第 201+ 个没有 pill |
| CJ-04 | P2 | `jobs-pill.tsx:622-651` + `shared/jobs.ts:153-157` | 「bridge 太旧」是终态却与瞬时失败同路 → 每 4s 无限重试同一条错误 pill |
| DLV-12 | P3 | `.github/workflows/sync-upstream.yml:110-119 vs 60-90` | CI 冲突处理清单漏 rewind-merge/mcp-http/doctor/probe 4 个自动门，注释仍称「与 CI 一致」 |
| CORE-10 | P3 | `server.js:405-408,2746-2754` | jobs 注释称「turn/end 清理」「timeline read」，实现均不存在（注释强于实现） |
| RW-05 | P3 | `server.js:2484-2500` | 第二次 planRestore 失败把 journal 路径塞进 `files.failed`，插件渲染成「内容已另存到 rescueDir」，文案不自洽 |

### 4.2 基线已有但上一轮未记录的 P2

| ID | 区域 | 摘要 |
|---|---|---|
| CORE-02 | 桥会话列表 | `paseo/sessions` 用 id 含 query / cwd 字符串全等预过滤，比宿主契约窄：标题搜索与 symlink cwd 的会话被桥先丢掉（实测 query=标题词返回 0） |
| CORE-03 | 桥取消 | 冷会话 agent 创建在飞时 cancel 抛 unknown session，prompt 侧不受影响仍会开回合（实测） |
| CORE-04 | 桥持久化 | `withTimeout` 只 race 不取消：`persistence.open` 超时后迟到的句柄无人 close（DSH open 支持 signal，桥未传） |
| BM-03 | MCP | `CallToolResult` 未校验：`content` 非数组 / `isError` 非布尔 / `task` 结果均「成功空内容」（实测 3 种） |
| BF-02 | 文件快照 | 并发捕获先分配序号后读文件：父子并行编辑时早序号可能读到后写内容，`planRestore` 选错 pre-image（延迟注入实测） |
| BF-03 | 文件恢复 | 部分成功回执不响亮：捕获期 skip/失败不进 journal，恢复期 skipped 只在 failed>0 时提示；doc 声称「回执会说明」不成立 |
| CT-02 | 客户端 | 终端输出 6000 字符硬截断且无滚动/复制（DSH 是全量 + 224px 滚动 + copyText），截断可切代理对 |
| PP-01 | 插件进程 | close 与在途 prompt 竞态：prompt 在 `await #ensureSessionReady` 后才写帧，close 落窗口时线上顺序为 close→prompt，桥重建已关闭 agent、写幽灵回合（假桥探针实测） |
| PP-02 | 插件进程 | 出站无背压、`#pending` 无上限：`stdin.write` 返回值被忽略、无 drain |
| HC-01 | 横切 | 分帧双实现漂移：插件侧 256 MiB 上限、桥侧完全无上限；单帧无界可 OOM 拖垮全部会话 |
| HC-02 | 横切 | 用户可见路径失败只进 stderr：history 重放 RPC 抛错时重开会话空白无提示；preset 被拒无 warning |
| HC-03 | 横切 | catalog 缓存单槽按 cwd 互斥，多 workspace 交替打开每次冷启 dsh probe（仓库注释实测 1.5–2.7s） |
| LP-02 | 补丁 | checker/`apply --check` 不复用 apply 的运行时字段门禁：上游字段改名时 check 报 patchable、apply 必拒，升级期静默降级 |
| PP-03 | bootstrap | 桥替换非原子：先 rmSync 再逐文件写，失败后仍注册 provider 并报 "profile ready"，半份桥留到下次加载 |

### 4.2.1 plugin-timeline 的 P3（该 lane 无 P2）

工具行状态机/compaction/分帧/首 token 这组模块是全仓成熟度最高的一批（`timeline-check` 208 项、
`frame-reader-check` 32、`p003-timeline-check` 8 全绿，首 token 与已装 DSH 差分 5000/5000 一致），
只登记 7 条 P3：`#toolInputs` 等每会话缓存无生命周期/字节预算（write 正文长期驻留，FT-01）、
`subagent_fork` 未映射成 `sub_agent`（FT-02）、canary/notice/错误文案 locale 中英混排（FT-03）、
frame-reader 上限只在未终止尾段检查且 `dropped` 计数不全（FT-04）、first-token 无差分门且
「verbatim」措辞偏强（FT-05）、bash 读 `input.cwd` 而 DSH 参数是 `workdir`（死字段）/失败 identity
丢弃/未知 content block 静默丢弃（FT-06）、todo 行追加语义可达性未验证（FT-07）。

### 4.3 健康度评分汇总（各 lane 1–5 分）

| lane | 正确性 | 健壮性 | 可维护性 | 契约 | 性能 | 安全 | 测试 | 总体 |
|---|---|---|---|---|---|---|---|---|
| bridge-server-core | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 3.3 |
| bridge-server-rewind | 4 | 4 | 3 | 3 | 4 | 4 | 4 | 3.7 |
| bridge-files | 3 | 3 | 3 | 3 | 4 | 3 | 4 | 3.0 |
| bridge-mcp | 3 | 3 | 3 | 2 | 3 | 3 | 3 | 2.9 |
| bridge-misc | 3 | 3 | 3 | 3 | 4 | 2 | 3 | 3.0 |
| plugin-session | 2 | 3 | 3 | 2 | 4 | 4 | 3 | 3.0 |
| plugin-provider | 4 | 4 | 3 | 3 | 4 | 3 | 4 | 3.6 |
| plugin-process | 3 | 3 | 3 | 3 | 3 | 4 | 3 | 3.1 |
| plugin-timeline | 4 | 4 | 4 | 4 | 4 | 4 | 4 | **4.0** |
| client-toolcall | 3 | 3 | 3 | 3 | 3 | 5 | 3 | 3.3 |
| client-jobs | 3 | 3 | 3 | 3 | 2 | 4 | 2 | 2.9 |
| client-misc | 3 | 3 | 3 | 3 | 4 | 5 | 3 | 3.4 |
| local-patches | 3 | 2 | 3 | 2 | 4 | 4 | 1 | 2.7 |
| delivery | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 3.0 |
| harness-bridge | 4 | 3 | 3 | 4 | 4 | 3 | 3 | 3.4 |
| harness-plugin | 4 | 3 | 3 | 3 | 4 | 3 | 4 | 3.4 |
| health-crosscut（全仓） | 4 | 3 | 3 | 3 | 3 | 4 | 3 | 3.4 |

**全仓综合约 3.2/5。** 最低两项是 `local-patches`（2.7，文本补丁测试覆盖 1/5）与
`bridge-mcp`/`client-jobs`（2.9）；最高 `plugin-timeline`（4.0，工具状态机/compaction/分帧是本仓
成熟度最高的一批，本轮只报 7 条 P3）与 `bridge-server-rewind`（3.7，撤回事务修复质量好）。
所有 lane 一致结论：**无 P0/P1、无阻断性健康问题**。

## 5. 测试体系与验证结果

### 5.1 本轮实际执行（verify-runner，只读、离线）

| 检查 | 结果 |
|---|---|
| `tsc --noEmit`（paseo-plugin） | exit 0，4.96s |
| `dsh-api-contract-check.mjs` | 12/12，DSH 0.2.1-rc.5 八个内部包全部命中 |
| `bridge-assets-check.mjs` | 2/2，21 个桥文件逐字节一致 |
| `plugin-build-check.mjs` | 86/86 |
| harness 纯离线/假桥脚本 | **52 个全部 exit 0**；合计与门禁类共 **56/56 通过、0 失败、0 环境缺失** |
| 未执行 | 13 个需真实模型/daemon/真实 profile 的检查（`plugin-check`、`route-test`、`probe`、`tools`、`stream-probe`、`rewind-e2e`/`merge-e2e`/`native`、`archive-registry`、`subagent-live`、`p003-live`、`p003-approval-preflight`）+ `session-calls`（诊断工具） |

覆盖差异（verify-runner 明示）：host-contract 只跑 patched 半场；catalog 无断言；
replay-fidelity 选中的真实日志无撤回标记；手工编译组共用一个 `.dbg-verify` 树。

### 5.2 测试体系的独立判断（harness-bridge / harness-plugin）

- **主体健康**：假桥/编译真实实现的脚本多数把断言打在事件、id、状态、错误码与终态上，
  负向对照做得比一般项目好；本轮 210 项 MCP 相关、115 项 revert、90 项 subagent 全部通过。
- **但「全绿」不能当发布判据**：
  - `plugin-check` 的 T03/T04、`route-test` 的 T01、`tools.mjs` 的 T02 仍是假绿判据（本轮已独立复现）；
  - 真实 profile/模型脚本无 `DSH_HOME` 隔离（会写真实 `~/.dsh`、耗 token）；
  - 19 个脚本手工编译到共享 `.dbg*` 树，无机器可读清单；
  - `session-calls` 在无 `request/header` 时仍 exit 0（空转可过）；
  - 桥入口接线（`dsh-bridge/lib/index.js` 的钩子）、祖先 symlink、jobs 路径三类零行为覆盖。

## 6. 文档一致性（docs-consistency）

13 份文档对照 HEAD：无 P0/P1，4 条 P2 + 11 条 P3。主要漂移：

- `paseo-plugin/OVERVIEW.md:9` 称本地/`file://` 图片不显示，实际 `image-host-path` + timeline 已支持；
- `docs/ADOPTION.md:383` 称桥每会话新起、改动立即生效，实际一连接共享一个子进程且需重载；
- 版本声明三处矛盾：`README.md:452` 写 0.2.11、`package.json` 0.2.16、npm latest 0.2.17；
  `paseo-plugin/README.md:18-21` 仍写「npm 最新 0.2.9、等 0.2.10」（历史注记未标历史）；
- 桥依赖数写 5 个、实际 8 个；Node 最低版本 18 vs 22；ADOPTION「bridge 8 个方法」vs 24 个 case；
- REWIND/RENDER-PLAN 的行号锚点已漂移（属可维护性，不影响结论）。

## 7. 阴性结论（已核查，避免重复怀疑）

- 无 TODO/FIXME 遗留；44 处 `catch {}` 均带注释或明确降级说明；
- 桥 19 个模块全被引用；内嵌桥生成器覆盖 19/19 且逐字节一致；
- 定时器/监听器/子进程清理基本成对；无界缓存扫描点基本有界（MCP 图片临时目录与附件副本除外）；
- `cacheWrite` 之外的 provider/模型/版本口径在 `package.json`/lock 内自洽；`npm pack` 43 文件完整；
- cedeaf3（usage 重开补发）与 jobs 新增代码未发现外围回归；`context-usage-check` 15/15、
  `concurrent-open-check` 14/14、`multi-session-check` 35/35 均通过。

## 8. 建议的下一步（按优先级）

1. **修撤回一致性（本周期新引入 × 3）**：RW-01 票据随 close 清理、RW-02 把 `runMaintenance`
   移出 conversation-only 路径并加契约探测、RW-04/BF-04 闸门只服务文件恢复且不吞 3s。
2. **修会话竞态**：PP-01（close 后迟到的 prompt 必须被拒）、CORE-03（创建中 cancel 要么排队要么点名）、
   CORE-04（withTimeout 传 signal）。
3. **关掉既有 P2 的正确性欠账**：S02/S03/S04（配置单源与失败回读）、S06（已完成 child 不被改写）、
   BR-03/BR-04/BR-05、BM-01/BM-02/BM-03。
4. **修交付假绿**：D1（doctor 用解析后对象）、D2（401/402/403 不产生能力结论）、
   T01–T04（把假绿判据改成会红的反例）。
5. **jobs 四个 P2**：可见性规则（先定产品语义：历史可见 or 纯 live）、轮询退避/聚合、分页、终态码。
6. **文档口径**：版本/进程模型/图片三处 P2 漂移；CI 补 push/PR 离线门。
7. 每条修复都按上轮做法：先固化为「修复前失败、修复后通过」的回归，再动代码。

## 9. 证据边界

这是对当前 HEAD 的全项目范围审查，不是所有传递依赖、所有 profile 组合或所有设备的正确性证明。
未执行/不能证明的层已逐项标注：真实模型回合、真实 daemon 撤回、Paseo App 真机 UI/动画/手势、
压力与内存峰值、iOS/Android、真实 registry 归档往返、真实文件系统攻击面（symlink 利用仅为同用户私有目录复现）。
生成桥用字节一致性检查；大块内嵌资产不做逐字节视觉审核；第三方依赖未逐行审计。

## 10. 修复轮结果

修复轮由 11 个代码/测试包 + 1 个文档包（p11-docs）组成，补丁均基于基线 `2f71225`。
状态定义：**fixed**＝已修并带「修前红→修后绿」回归；**blocked**＝缺稳定扩展点或需产品决定；
**暂缓**＝明确本轮不做或留待真实环境验证。下表按包汇总，逐条细节见各包报告。

### 10.1 fixed

| 包名 | 条目 |
|---|---|
| p1a-rewind-txn | RW-01 / CORE-05、RW-02、BF-04、RW-04、RW-05（桥侧；插件提示由 p1b 接入） |
| p1b-snapshots | BR-04 / BF-01 / H-02、BF-02、BF-03、BR-03 / BM-02；`files.error` 回执接入 |
| p2-bridge-core | CORE-01 / BR-05、CORE-02（query 侧不预过滤；cwd 侧改 realpath 感知的超集预过滤）、CORE-03、CORE-04、CORE-10（仅注释） |
| p3-bridge-mcp | BR-06、BR-07 / BM-02、BM-03、BR-08 |
| p4-plugin-session | S02 / S-07 / PP-01、S03、S04 / S-04、S05、S06、S07、S-02 |
| p5a-plugin-process | PP-01、PP-02、HC-01 |
| p5b-plugin-provider | PP-03、HC-02 / PP-07、HC-03、PP-05 |
| p6-jobs | CJ-01（按已定路线 1：历史可见）、CJ-02、CJ-03、CJ-04 |
| p7-client | C1、C2、CT-02 |
| p8-delivery | D1、D2 / DLV-02、L1、LP-02、DLV-12 |
| p9-harness | T01、T02、T03、T04、HP-08、H-01；附加项 HP-05（真实脚本默认一次性 DSH_HOME） |
| p11-docs | docs-consistency D01–D15 的 P2 全部处理；P3 中 D05–D09、D11–D15 按核实结果修正（D06 的 Node 最低版本按桥实际使用的 `AbortSignal.any` / `Symbol.dispose` 修为 20.4；D10 的 REWIND 行号已改符号名，RENDER-PLAN.md 不在本包写入边界）；HC-04 版本声明统一；AGENTS.md 补登本轮 harness 清单；REWIND/FIELD-NOTES 同步本轮语义 |

### 10.2 blocked

| 包名 | 条目 | 原因 |
|---|---|---|
| p5b-plugin-provider | PP-02 / S08 | 共享子进程的 per-agent shell env 没有稳定注入点（DSH `ctx.shellEnv` 只接受 `DSH_` 前缀、桥 `initialize` 不收 env、插件只有 spawn 级 env）。不做「env 分池」等破坏性假修复；原因与选项见 p5b 报告 §2 |

### 10.3 暂缓

| 范围 | 内容 |
|---|---|
| VERDICTS | HP-06（编译基建重构，非缺陷）本轮暂缓；§8 未点名的 P3 本轮不处理 |
| 真实环境验证包 | `plugin-check.cjs` 真实模型回合、`route-test`、`probe`、`tools`、`stream-probe`、`rewind-e2e` / `rewind-merge-e2e` / `rewind-native-check`、`archive-registry-check`、`subagent-live`、`p003-live*` 等需要真实 profile/daemon/模型的项，均未在本轮执行，需用户批准后补跑（耗 token） |
| p5a / p7 / p6 / p1b / p5b | 出站预算压力实测（p5a）、terminal 全量正文的移动端渲染性能（p7）、settled 历史仍全量轮询（p6，需桥侧 `liveOnly`/增量）、恢复期 TOCTOU 边界（p1b）、同 cwd 并发 miss 不合并（p5b）——均为已记录的性能/边界项，本轮不改 |

### 10.4 待用户决定

**S08 / PP-02（p5b）——共享子进程的 per-agent 环境变量怎么处理。** 仅列选项，不作结论：

- **A**：DSH 上游给 `ctx.shellEnv` 增加受信插件可用的非 `DSH_` 前缀贡献（或官方 per-agent shell env 配置）；桥把 agent 身份按 session 保存，执行时按 `execution.agent` 解析。
- **B**：按 agent identity 给 env 分池，每个 agent 一个 DSH 子进程。代价是每会话冷启动（1.5–2.7 s），且必须先解决 `archivedSessionIds` 的跨进程一致性。
- **C**：反向「失败要响亮」——从 spawn env 剥掉 `PASEO_AGENT_ID` / `PASEO_AGENT_CWD`，让依赖 caller 的 CLI 明确报「不在 Paseo agent 内」。代价是所有会话经 bash 的 heartbeat / schedule / agent send 都不可用，直到 A 落地。
- **D**：维持现状，在文档 / FIELD-NOTES 记录该限制（本轮文档包已记录；不改变行为）。
