# 交付 / 测试 / 文档侧修复核查（fix-verify-delivery，2026-11-03）

- 核查对象：`main` HEAD `0c82df5`（工作区仅 `V1.txt` / `v1.txt` 未跟踪；本 lane 只新增本报告，未改任何产品代码/文档/harness）。
- 对照基线：`docs/FULL-AUDIT-20261102.md`（基线 `2f71225`）§10.1 的 p8-delivery / p9-harness / p11-docs 条目、§10.2–§10.4。条目原文见 `docs/audits/20261102/{delivery,harness-plugin,harness-bridge,docs-consistency,local-patches,health-crosscut,plugin-provider}.md`。
- 方法原则：**不采信提交信息**。先 `git diff 2f71225..HEAD -- <file>` 定位每处修复，再在当前 HEAD 复跑原始反例；关键条目另用 `git archive 2f71225` 解出基线源码、以同一份探针取得「修前红」对照。
- 环境：Node v22.23.1、DSH 0.2.1-rc.5、Paseo 0.14.0。未跑真实模型回合、未读写真实 `~/.dsh` profile（全部 `DSH_HOME` 在 `/tmp` 沙箱）、未跑真实 daemon、未装包、未做 git 写操作。

## 1. 方法

1. **交付层（D1/D2）**：`/tmp` 沙箱 `DSH_HOME` + stub `dsh`/`paseo` CLI 驱动真实 `paseo-dsh doctor`；loopback 假网关驱动真实 `paseo-dsh probe`。同一批用例分别指向 HEAD 与 `git archive 2f71225` 基线源码，比较判定与 exit code。
2. **local-patches（L1/LP-02）**：从已安装 `@getpaseo/server` 的**真实补丁文件副本**构造「陈旧补丁体 + 无关 tail」fixture，用 `REWIND_PATCH_TARGET`/`REWIND_PATCH_TURNID_TARGET`/`REWIND_PATCH_HOME` 把真实 `apply`/`check` 脚本限制在 `/tmp`，不触碰已安装包；另用自建 clean fixture 验证字段改名与 #7675 形状。同一 fixture 对基线脚本复跑取红。
3. **harness（T01–T04/HP-08/H-01/HP-05）**：读修复 diff 确认判据真的换了数据源；跑修复轮新增的纯离线回归 `harness-gates-check.mjs`（内含真实 `route-test.mjs`/`tools.mjs` 对假 peer 的行为断言）、`bridge-entry-check.mjs`、`plugin-check.cjs --self-test`；HP-08 用自建 zstd 会话日志复跑；H-01 另做「删钩子」变异测试证明新检查有归因力。真实模型回合按约束未跑。
4. **文档（D01–D15/HC-04）**：逐项对照当前 HEAD 实际文件内容；基线原文用 `git show 2f71225:<file>` 验证漂移确实存在；npm 版本用只读 `npm view paseo-dsh version` 核对（实测 `0.2.17`）。
5. 证据等级：**【实测】**＝本机命令 + exit code/输出片段；**【静态】**＝源码/文档逐行对照；**【未验证】**＝明确未执行。

## 2. 逐条状态

### 2.1 p8-delivery

| 条目 | 状态 | 证据（修前 → 修后） |
|---|---|---|
| **D1** doctor 语义校验按 regex、7 类畸形配置全绿 | **fixed** | **HEAD【实测】**：7 类原始形状（`provider:""`、`model:""`、`agent-default-model.config` 为空且后续无关条目带 provider/model、`refs.X: ""`、`refs.X: # no value`、refs 结束后另一顶层区块同名 key、`disabled: true`、路由引用未定义 provider）全部 `[fail]` + **exit 1**；正对照（真实模板形状）`All checks passed` + exit 0；凭据缺失负对照 fail。**基线【实测】**：同一批畸形配置全部 `All checks passed` + **exit 0**（少数变体由旧 regex 偶然拦住，但上述 7 类均绿）。代码侧：`paseo-plugin/lib/doctor.mjs:487-557` 已改为解析后对象判定（`patchEntries`/`entryById`/`providerProfiles`），桥文件完整性另见 `:440-465`。`node harness/doctor-check.mjs` **37/37**。 |
| **D2 / DLV-02** probe 把 401/402/403 当能力拒绝并 exit 0 | **fixed** | **HEAD【实测】**：loopback 假网关「baseline 200 → 之后 401/402/403」三组均为 `role=developer unknown`、`reasoning_effort=* unknown`、无 `reasoningEfforts: false` 建议、**exit 1**；429 对照 unknown/exit 1，400 明确参数拒绝对照 rejected/exit 0（保持原正确行为）。**基线【实测】**：401/402/403 均 `REJECTED -> needs compat.supportsDeveloperRole: false` + 6 档全 rejected + 打印 `declare reasoningEfforts: false` + **exit 0**。代码侧：`paseo-plugin/lib/probe-provider.mjs:158-166`（401/402/403/408/429/5xx 不产生能力结论）、`:371-376`（无结论 exit 1）。`node harness/probe-check.mjs` **46/46**。 |
| **L1 / LP-01** 补丁 stale 重建删无关 tail | **fixed** | **HEAD【实测】**：真实补丁文件副本改出陈旧方法体 + 在 `revert()` 的 CALL 之后插入 `this.upstreamCleanupAfterRewind();`（另一条 `emitAuditRow`）→ `stale-patch-call-region-foreign`，**文件 md5 逐字节不变**，warning 点名将删除的语句，exit 3（DEGRADED，显式降级）；无无关 tail 的对照正常 `patched-from-stale` 重建成功。**基线【实测】**：同一 fixture `OK (patched-from-stale)`、**exit 0**、tail 计数 0、md5 改变——无声删除复现。代码侧：`local-patches/apply-rewind-history-truncation.mjs:1379-1428`（`foreignTextAroundPatchCall`）、`:1442-1462`（fail closed）。`node harness/local-patches-check.mjs` **16/16**。 |
| **LP-02** checker 与 apply 形状门禁不一致 | **fixed** | **HEAD【实测】**：`this.timelineSnapshots` 改名 fixture → checker `{code:2, state:"host-fields-changed", autoPatchable:false}`、`apply --check` 明确 `host-fields-changed ... apply will refuse`（exit 1）、实际 apply 拒绝且文件未变；#7675 形状（`new PluginSessionHistory(` 仅出现在注释）→ `upstream-history-shape-changed`（checker code 2 / apply exit 1）；兼容 clean 文件对照仍 `patchable`（checker code 1）且能正常 apply。**基线【实测】**：同一改名 fixture checker `{code:1, state:"patchable", autoPatchable:true}`，而 apply 实际以 `host-fields-changed` 拒绝——静默降级复现。代码侧：`local-patches/check-rewind-patch.mjs:172-190,262-282`；`apply-rewind-history-truncation.mjs:2742-2760`（`checkBothTargets` 复用同一门禁）。 |
| **DLV-12** CI 冲突清单与自动门漂移（本轮新引入） | **fixed** | **基线【实测/静态】**：自动门有、冲突清单缺 `rewind-merge-check` / `mcp-http-check` / `doctor-check` / `probe-check` 4 项。**HEAD【静态】**：归一化后两清单 24 个 harness 门**完全一致**（差集为空），见 `.github/workflows/sync-upstream.yml:76-79` 与 `:128-135`。 |

### 2.2 p9-harness

| 条目 | 状态 | 证据（修前 → 修后） |
|---|---|---|
| **T01** route-test 有 partial 文本即 WORKS、全 FAIL exit 0 | **fixed** | **HEAD【实测】** `node harness/harness-gates-check.mjs`（41/41）中真实 `route-test.mjs` 对假 peer：`partial text + fatal error → FAILS`（exit 1）、无 `turn/end → TIMEOUT`、全失败 sweep **exit 1**、全干净对照 **exit 0**。代码侧 `harness/route-test.mjs:15-20`（按 terminal 分类）、`:150,207,245-248,287`（等自己的 `turn/end`，`routeExitCode(outcomes)`）。基线旧判据原文为「有文本即 WORKS、无终态等待」，见 `docs/audits/20261102/harness-plugin.md:73`。 |
| **T02** tools.mjs initialize 不带 sessionId | **fixed** | **HEAD【实测】** 同一回归中真实 `tools.mjs` 对严格 per-session 假桥：initialize 与 prompt 的 `sessionId` 相同（`tools-<ts>`）、**exit 0**、1.4s 结束（无 180s timer 残留）。代码侧 `harness/tools.mjs:130-134`（两帧共用 `SESSION_ID`）、`:64-72`（timer unref）。 |
| **T03** plugin-check 先过滤非 assistant 行再验邻接 | **fixed** | **HEAD【实测】** `harness-gates-check.mjs` T03 块：完整序列 `assistant A → reasoning THINK → assistant AB` 判为 fragmented；旧的 assistant-only 过滤器在同一序列上只投影 1 行（回归见证）；`tool_call` 打断亦然；正对照相邻同 id 合并为 1 行。代码侧 `harness/plugin-check.cjs:511-513` 用 `timelineItemsWithTurns` + `assistantFragmentation` 折完整序列。 |
| **T04** plugin-check 用 prompt 自带的 IMAGE-SEEN 当图像证据 | **fixed** | **HEAD【实测】** `plugin-check.cjs --self-test` 通过：结构化谓词接受真实 image block、拒绝 `IMAGE-SEEN` 文本占位；`harness-gates-check.mjs` T04 块同样证明旧文本谓词在零图片块时通过（回归见证）。代码侧 `harness/plugin-check.cjs:537-548`：断言 `DshProcess.prototype.prompt` 记录的 prompt frame 携带**精确图片字节 + mimeType**，并有「不同 payload 不匹配」负对照；`:502-513` 顺带修掉 T03。真实模型回合未跑（见 §6）。 |
| **HP-08** session-calls 无 schema 仍 exit 0 | **fixed** | **HEAD【实测】** 自建 zstd 会话：无 `request/header` → `[no schema]` + **exit 2**、`arguments` 非 JSON → `[UNCHECKED]` + exit 2、有 header 且干净 → exit 0、有未声明键 → exit 1。**基线【实测】** 无 header 同一 fixture → **exit 0**。代码侧 `harness/session-calls.mjs:245,268,279,297-301`。 |
| **H-01** 桥入口事件接线无行为级测试 | **fixed** | **HEAD【实测】** `node harness/bridge-entry-check.mjs` **13/13**：加载真实 `dsh-bridge/lib/index.js`（`:40,188`）并驱动假 ctx，断言 ticket 先于 snapshot、post-execute 提交+释放、failed snapshot drop、未准入不 commit、`rememberToolDescription` 先于执行。**变异测试【实测】**：在 `/tmp` 复制桥源码把 `scope.on('tools/post-execute'…)` 改成 `scope.off` → 检查立即红（`fs scope registers tools/post-execute` FAIL 等），证明该检查对钩子删除有归因力（不是只跟着源码文本自证）。 |
| **HP-05** 真实脚本默认一次性 DSH_HOME | **部分修复 / still-broken（probe.mjs）** | **HEAD【实测/静态】**：`harness/isolated-dsh-home.cjs:57-99` 提供默认克隆 + 凭据 symlink + `--allow-real-profile` opt-in；`plugin-check.cjs`、`route-test.mjs`、`tools.mjs`、`stream-probe.mjs`、`rewind-e2e.mjs`、`rewind-merge-e2e.mjs` 均已接线（grep `prepareDshHome` 全部命中），`harness-gates-check` HP-05 段 PASS（默认 isolated、凭据 symlink、cleanup、`--allow-real-profile` 显式 real 四项，另有各脚本的 wiring 断言）。**但原始 HP-05 点名的 `harness/probe.mjs:25-31` 仍未接线**：`spawn('dsh', ['--profile', PROFILE], { env: process.env })` 直接继承真实 `~/.dsh`，会向真实 `~/.dsh/sessions` 写会话并写 `harness/frames-probe.jsonl`；`harness/catalog.mjs` 同类。`AGENTS.md:177` 自认「catalog / probe 仍读写真实 profile」，与 §10.1「真实脚本默认一次性 DSH_HOME」的覆盖范围不符。 |

### 2.3 p11-docs（D01–D15 / HC-04 / harness 登记）

| 条目 | 状态 | 证据 |
|---|---|---|
| D01 OVERVIEW 称本地/`file://` 图片不显示 | **fixed** | `paseo-plugin/OVERVIEW.md:9` 已改为「Images work both ways…hostPath…file:// Markdown row that Paseo loads through its file RPC」；基线原文「Images flow one way…only from an https:// URL」见 `git show 2f71225:paseo-plugin/OVERVIEW.md:9`。 |
| D02 ADOPTION 称 bridge 每会话新起、改动立即生效 | **fixed** | `docs/ADOPTION.md:390-395`：一个 provider 连接共用一个 `dsh` 子进程，插件加载整体替换内嵌桥，已运行子进程不热加载，须重载插件/重启 daemon。基线 `:383` 的「每个会话新起」原文已不存在。 |
| D03 README 仍写 npm 最新 0.2.9 / 等 0.2.10 | **fixed** | `README.md:109-110`、`README.en.md:123-124`、`paseo-plugin/README.md:18-21` 均把 2026-10-20 注记标为「历史注记」，写明 npm 最新 `0.2.17`、等待条件已满足。 |
| D04 README 称仓库当前 0.2.11 且尚未发布 | **fixed** | `README.md:467-468`（`README.en.md:552-553` 同）：版本号以 `paseo-plugin/package.json` 为唯一来源（实测 `0.2.16`）、npm 最新 `0.2.17`（2026-10-30），发布等实测确认。`npm view paseo-dsh version` 实测 `0.2.17`。 |
| D05 桥依赖写 5 个、实际 8 个 | **fixed（文档）** | `README.md:345-348`、`README.en.md:395-398`、`paseo-plugin/README.md:64-66` 均为「八个」并列出 8 包。残留：`paseo-plugin/lib/doctor.mjs:56,362` 源码注释仍写「five」（原报告已注明「源码注释，顺带」，非文档条目）。 |
| D06 Node 最低版本 18 vs 22 | **fixed** | 统一为 **Node ≥ 20.4**：`README.md:350-353`、`README.en.md:402`、`paseo-plugin/OVERVIEW.md:5`、`paseo-plugin/README.md:62,131`；依据实测核对：`dsh-bridge/lib/approval.js:14` 等用 `AbortSignal.any`（20.3）、`dsh-bridge/lib/session-projections.js:41` 用 `Symbol.dispose`（20.4）。 |
| D07 界面语言表述不精确 | **fixed** | `README.md:355-361,388-394`：明确语言来自 daemon 环境（`DSH_PASEO_LANG`/`LC_ALL`），不是 Paseo App 设置；客户端默认 `zh-CN`、收到首个 tool-call 后才切且已渲染行不重绘。 |
| D08 更新日志缺 0.2.17、0.2.15/16 日期错 | **fixed** | `README.md:479-481`：0.2.17（2026-10-30）条目已补；0.2.16/0.2.15 日期改为 2026-10-29。README.en 对应同步。 |
| D09 ADOPTION「bridge 8 个方法」不完整 | **fixed** | `docs/ADOPTION.md:75` 保留「最小集合 8 个」，`:88-89` 补「当前实现已扩到 24 个请求方法」并列举。 |
| D10 REWIND 行号漂移 | **fixed（REWIND）/ 残留（RENDER-PLAN）** | `docs/REWIND.md:55,138` 已改为符号名（`settleAgentForRevert`、`TRACKED_TOOLS`/`isTrackedTool`/`mutationPathOf`），无 `.js:行号`；`docs/RENDER-PLAN.md:260` 仍写 `server/timeline.ts:916`（实际 `isError` 判据在 `paseo-plugin/server/timeline.ts:1110`）——原 §10.1 已声明 RENDER-PLAN 不在本包写入边界，属已知残留。 |
| D11 FIELD-NOTES「13 种事件只映射 4 种」 | **fixed** | `docs/FIELD-NOTES.md:2336` 已改为 9 种 durable 事件（并区分 activity-timeline 的 4 个事件与瞬时 delta）。 |
| D12 能力清单滞后（jobs/goal/workflow/审批/systemPrompt/projections） | **fixed** | `README.md:26-29` 增补 jobs pill、goal/workflow 时间线、工具审批卡、会话级 system prompt；`paseo-plugin/OVERVIEW.md:7`、`paseo-plugin/README.md:52-56` 同步。 |
| D13 ADOPTION「必须成对出现」误导 | **fixed** | `docs/ADOPTION.md:177`：「`compat.supportsDeveloperRole: false` 是条件性配置，不是 `reasoningEfforts` 的配对项」，并说明仅网关拒绝 developer 角色时才加。 |
| D14 AGENTS「Paseo 0.15 自己刷新撤回时间线」未验证写死 | **fixed** | `AGENTS.md:82` 改为「上游真正修掉 #4667…当前 #4667 仍 open，补丁仍在用」；`docs/REWIND.md:135-136` 同口径。 |
| D15 FIELD-NOTES 编号歧义 / AGENTS 计数 | **部分修复（新漂移）** | `AGENTS.md:59-60` 已加「历史段落里 22–25、46–47 有重号，引用旧条目时带标题」，但同一句「编号到 77」在 HEAD 已过期：`docs/FIELD-NOTES.md` 当前有第 78、79 条（`:2727`、`:2753`，撤回提示语义，本轮后段提交新增）。 |
| **HC-04** 版本声明三处矛盾 | **fixed** | 版本：`README.md:467-468` / `README.en.md:552-553` 以 `package.json` 为唯一来源（`0.2.16`），npm 最新 `0.2.17`（实测）；Node：README/EN/OVERVIEW/包 README 统一 ≥20.4；`paseo-plugin/README.md:18-21` 历史注记已标注。 |
| **AGENTS.md 补登本轮 harness 清单** | **fixed（本轮新增项）** | 修复轮新增的 `bootstrap-check` / `bridge-entry-check` / `catalog-cache-check` / `harness-gates-check` / `local-patches-check` / `open-degrade-check` / `session-state-check` / `mcp-gateway-call-check` / `transport-frame-check` 均已登记在 `docs/HARNESS.md`（逐项 grep 命中）；AGENTS.md 保持指针（23.8 KB < 64 KiB 预算），并登记了 `harness-gates-check`、`local-patches-check` 的必跑触发。残留：`docs/HARNESS.md` 目前只引用 60/84 个 harness 文件（24 个未登记，如 `file-snapshot-check.mjs`、`revert-check.mjs`、`rewind-e2e.mjs`），属既有索引完整性问题（与 verify-runner 独立统计一致），非本轮新增。 |

## 3. blocked / 暂缓 / 待用户决定项现状

| 分类 | 条目 | 现状 | 证据 |
|---|---|---|---|
| §10.2 blocked | PP-02 / S08 共享子进程 per-agent env 无稳定注入点 | **blocked-still（原因仍成立）** | 插件仍在 `paseo-plugin/server/provider.ts:794` 显式跳过 `PASEO_AGENT_ID` / `PASEO_AGENT_CWD` 的差异告警（不冒充已处理）；桥 `initialize` 无 env 通道；DSH 侧 `dsh-shell-env/lib/index.js:32` 明确 `ctx.shellEnv` 只服务可信的 per-execution `DSH_*` 变量；`docs/FIELD-NOTES.md:2695` 第 76 条记录限制与「不造虚假修复」。 |
| §10.4 待用户决定 | S08/PP-02 的 A/B/C/D 选项 | **未决，无结论落地** | `docs/FULL-AUDIT-20261102.md:283-288` 仍为「仅列选项，不作结论」；`docs/FIELD-NOTES.md:2703-2705` 只写「选项记在…待用户决定；需要 DSH 上游扩展开关或产品取舍」；`git log` 无 S08/PP-02 决策或实现提交。 |
| §10.3 暂缓 | HP-06（编译基建重构，非缺陷） | **仍暂缓** | 当前 HEAD 仍有 **19 个** harness 脚本手工 `npx tsc`、无 `harness/manifest.*`（`grep -l "npx tsc" harness/*` = 19；`ls harness/manifest*` 无）。与 §10.3 一致。 |
| §10.3 暂缓 | 真实环境验证包（plugin-check 真实回合、route-test/probe/tools/stream-probe、rewind-e2e 系列、archive-registry、subagent-live、p003-live* 等） | **仍暂缓 / 未执行** | 本轮受约束只跑离线/假桥检查；`docs/audits/20261103/verify-runner.md` 独立记录 13 个真实模型/daemon/profile 脚本未执行。无任何真实环境结论被写入仓库。 |
| §10.3 暂缓 | p5a 出站预算压力实测、p7 terminal 全量正文移动端渲染性能、p6 settled 历史全量轮询、p1b 恢复期 TOCTOU 边界、p5b 同 cwd 并发 miss 不合并 | **仍暂缓（均未见本轮修复/实测）** | p5a：`paseo-plugin/server/dsh-process.ts:400-411,2477-2481` 有背压/上限实现但无压力实测；p6：桥/插件无 `liveOnly`/增量接口（grep 无命中）；p5b：`paseo-plugin/server/provider.ts:189-222` 只有按 cwd 的 LRU 缓存，无 in-flight 合并；p7/p1b 无对应性能/边界改动提交。 |

补充：§10.2 条目在报告中写作「PP-02 / S08」，但 §10.1 的 p5a 也有一条 `PP-02`（出站背压，另一问题）——同一编号两义，跟踪时需带包名，见 §4。

## 4. 新发现

1. **HP-05 的 §10.1 表述过度覆盖（P3）**：§10.1 写「真实脚本默认一次性 DSH_HOME」，但原始 HP-05 点名的 `harness/probe.mjs:25-31` 仍是 `spawn('dsh', …, { env: process.env })`，直接使用真实 `~/.dsh` 并写真实 sessions；`harness/catalog.mjs:12-18` 同类。`AGENTS.md:177` 已自认「catalog / probe 仍读写真实 profile」，说明是已知的未修部分，但 §10.1 fixed 清单未注明，建议改成「部分修复（probe/catalog 除外）」或给 probe/catalog 补 `prepareDshHome`。
2. **`AGENTS.md:59-60` 的 FIELD-NOTES 计数已过期（P3）**：写「编号到 77」，HEAD 的 `docs/FIELD-NOTES.md:2727,2753` 已有第 78、79 条（撤回提示 `timeline.append` 语义），引用旧条目时无影响，但「到 77」是错误事实。
3. **`docs/RENDER-PLAN.md:260` 行号仍漂移（P3）**：`server/timeline.ts:916` 实际为 `:1110`（`message?.isError === true`）。原 §10.1 已声明 RENDER-PLAN 不在 p11 写入边界，但该文档仍作为现行说明被引用，建议下轮顺手改符号名。
4. **`paseo-plugin/lib/doctor.mjs:56,362` 源码注释仍写「five DSH packages」（P4）**：实际为 8 个（D05 只修了 README/OVERVIEW/包 README）。不影响行为，属注释漂移。
5. **`docs/HARNESS.md` 索引不完整（P3，既有）**：84 个 harness 脚本中仅引用 60 个，24 个未登记（`file-snapshot-check.mjs`、`revert-check.mjs`、`rewind-e2e.mjs`、`surface-check.mjs` 等），与本项目「HARNESS.md 是逐脚本清单」的规则不符；与本轮 p11「登记本轮新增检查」不冲突，属历史欠账。
6. **`PP-02` 编号冲突（P4）**：`docs/FULL-AUDIT-20261102.md` §10.1 p5a 的 PP-02 是「出站无背压」（已修），§10.2 p5b 的 PP-02/S08 是「共享子进程 per-agent env」（blocked），同一编号指两个问题，建议改成 `PP-02a/PP-02b` 或带包名。

## 5. 阴性结论

- 本轮所有可离线复跑的修复回归均全绿：`doctor-check` **37/37**、`probe-check` **46/46**、`local-patches-check` **16/16**、`harness-gates-check` **41/41**、`bridge-entry-check` **13/13**、`plugin-check --self-test` PASS。
- 修复点稳定性：`6394809` 之后 HEAD 对 `doctor.mjs`、`probe-provider.mjs`、`local-patches/*`、`sync-upstream.yml`、`route-test.mjs`、`tools.mjs`、`plugin-check.cjs`、`session-calls.mjs`、`bridge-entry-check.mjs`、`harness-gates-check.mjs`、`isolated-dsh-home.cjs` **均 0 改动**，不存在「修复后又回退」。
- D1/D2/L1/LP-02 均取得「基线红 → HEAD 绿」的成对实测；DLV-12 为「基线差集 4 个 → HEAD 差集 0」。
- 未发现 p8/p9/p11 条目出现 regressed；文档旧表述（「每个会话新起」「0.2.9/等 0.2.10」「0.2.11 尚未发布」「13 种映射 4 种」「5 个依赖」「Node 18」）在 HEAD 均已不存在。

## 6. 未验证项

- **真实模型/真实 profile/真实 daemon**：`plugin-check.cjs` 完整回合、`route-test`、`probe`、`tools`、`stream-probe`、`rewind-e2e` / `rewind-merge-e2e` / `rewind-native-check` 等未执行（会耗 token、写真实 profile/daemon，按任务约束禁止）；T03/T04 的最终判据只在离线谓词与代码接线上验证，真实图片回合未跑。
- **Node 20.4 运行时**：只按代码符号与文档核对最低版本，本机仅在 Node 22.23.1 实测，Node 20.4 本身未跑。
- **npm 发布态**：`npm view paseo-dsh version` 实测 `0.2.17`（查询时点 / 2026-11-03）；docs 写「2026-10-30」为上一轮审计口径，未复核发布时间。
- **HP-05 真实写盘范围**：未在真实 `~/.dsh` 上运行 `probe.mjs` / `catalog.mjs`，结论基于源码与既有审计记录；隔离 helper 的写盘行为只在合成 source home 验证。
- **doctor 发布安装形态**：由 `harness/doctor-check.mjs` 的两目录 split 用例验证（实际 `paseo plugin add` 安装未复跑）。
- **D1 的「7 类」中 `refs.AUDIT_KEY:` 纯空值与注释空值**：HEAD 均 fail；基线对纯空值会偶然 fail、对注释空值绿——说明修复彻底性依赖解析器语义，未来 YAML 解析器差异仍是风险（未在 js-yaml 路径单独复跑，仅 yaml 路径）。
