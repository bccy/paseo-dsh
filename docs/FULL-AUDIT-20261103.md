# 全量代码健康度审查（2026-11-03）

- 审查基线：`0c82df5`（main；工作区仅未跟踪的 `V1.txt`/`v1.txt`，本轮未动）
- 上一轮全量审查：[FULL-AUDIT-20261102](./FULL-AUDIT-20261102.md)，基线 `2f71225`
- 环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node `v22.23.1`
- 分工：**24 个只读审查 lane**（生产代码 15 + 测试体系 3 + 修复核查 3 + 横切 2 + 新提交 1），
  全部 fresh 上下文、独立审查；分区报告与证据索引见 [audits/20261103](audits/20261103/README.md)
- 本轮只交付审查与证据：未修改任何产品代码/文档/harness、未 git 写、未跑真实模型/daemon、
  未写真实 `~/.dsh` profile、未装包、未发布

## 1. 结论

**代码健康度中等偏上（全仓约 3.6/5），没有 P0/P1 阻断性缺陷；上一轮修复轮质量高（桥侧 22/22、
插件侧 21/22 修复成立），但修复轮之后的新功能与残留欠账带来 22 条 P2。代码层无阻断缺陷，但**发布线未定（见 DC-02），
不可直接发布**；发布前还需补真实环境门与一次 canary 真机复验。**

四个最重要的判断：

1. **修复轮基本兑现。** 上一轮 `6394809` 的 fixed 清单经三条独立核查 lane 用「基线副本红 →
   HEAD 绿」双证复核：桥侧 §10.1 的 18 组 22 个 ID **全部 fixed、0 regressed**；
   插件/客户端 22 条中 **21 fixed、1 条口径过宽（CJ-02 仅部分修复）**；
   交付/测试/文档 p8/p9/p11 基本 fixed（HP-05 与 D15 为部分修复）。
2. **新功能链方向正确、无 P0–P2。** `e7472be..HEAD` 的撤回提示（canary + 完成报告 + 胶囊）与
   files-only 撤回共 +3374 行，主机制在**真实宿主 0.14.0 代码**上被双向复现：`timeline.append`
   绕过 rewind run lock、conversation/both 等 `timeline.replacement` 后落行、固定行 id 两层折叠、
   canary 顺序未被破坏；`files` scope 的事务边界被 `rewind-transaction-check` 17/17 钉住。
   剩余 6 条 P3 集中在**降级分支可能静默丢报告**与失败文案未本地化。
3. **真正要修的是三类「失败被吞」的 P2。** ①快照捕获/提交在读完字节之后失败只写 stderr、
   不进回执（撤回把「没恢复」报成「没改动」，三条 lane 独立确认）；②已原子落盘的写在取消/关闭
   窗口被判 error 后丢 pending（journal 漏行、静默漏恢复）；③content-addressed 对象只校验存在性，
   截断对象会被写回用户文件并报 restored。三者都在文件恢复路径上，是同一条「失败要响亮」的欠账。
4. **交付层的假绿在换位置。** D1/D2 已真修（doctor 改解析对象、probe 对 401/402/403 不再下能力结论），
   但 doctor 又暴露三条新的契约层假绿（凭据文档契约、补丁可应用性、profile 就绪），全部实测：
   doctor 全绿而真实 DSH 启动/装载失败。发布前诊断工具仍不能当判据。

按上轮定级口径（P0 数据丢失/安全灾难，P1 会话可用性/恢复正确性，P2 功能/数据/契约，
P3 显示/可维护性），本轮**没有 P0/P1**；P2 去重后 22 条（见 §4），其中文件恢复失败路径 3 条、
交付假绿 3 条、撤回提示降级窗口 2 条（按功能缺失口径）、文档/发布线 3 条最值得先修。

## 2. 范围与方法

24 个独立只读 lane，每个 lane 一个共享任务、一份分区报告；全部 fresh context、只读运行。
分区与文件归属见 [audits/20261103/README.md](audits/20261103/README.md) 的 Lane 索引。

| 区域 | lane | 代表文件/范围 |
|---|---|---|
| 桥（约 9.2k 行） | bridge-server-core / bridge-server-rewind / bridge-files / bridge-mcp / bridge-misc | `dsh-bridge/lib/` 19 个模块 |
| 插件服务端（约 19.2k 行） | plugin-session / plugin-provider / plugin-process / plugin-timeline / plugin-rewind-notice | `paseo-plugin/server/` 全部 |
| 客户端（约 8.2k 行） | client-toolcall / client-jobs / client-misc | `paseo-plugin/client/` + `shared/` |
| 可选宿主补丁（约 3.3k 行） | local-patches | `local-patches/` 全部 |
| 交付层 | delivery | doctor/probe/bin/scripts/manifest/CI/入口 |
| 测试体系（约 39k 行） | harness-bridge / harness-plugin / verify-runner | `harness/` 84 个脚本 |
| 修复核查 | fix-verify-bridge / fix-verify-plugin / fix-verify-delivery | 上轮 §10.1/§10.2/§10.3/§10.4 逐条 |
| 横切 | docs-consistency / health-crosscut | 13 份文档、全仓缺陷模式 |
| 新提交 | new-commits | `e7472be..HEAD` 逐 diff |

证据纪律：每条发现带 `file:line`、触发条件、证据等级（实测/源码推断/文档）与归属
（新引入 vs 修复轮 vs 基线）。修复核查要求在**当前 HEAD 副本**上复跑原始反例，并用
`git archive 2f71225` 解出基线副本取「修前红」对照，不采信提交信息。
未执行的层（真实模型回合、真实 daemon 撤回、真机 UI、压力/内存）在分区报告里逐项列为未验证。

**Lead 亲手验收**（不采信 lane 自报；按全局分工规则门禁脚本应派验证代理跑，本轮由 Lead 直接跑属例外，如实记录）：`tsc --noEmit` exit 0；`git status` 仅
`V1.txt`/`v1.txt`/`docs/audits/20261103/`；以下离线门全部 exit 0 且断言数与会话一致：
`dsh-api-contract-check` 12/12、`bridge-assets-check` 2/2、`rewind-notice-check` 63/63、
`rewind-transaction-check` 17/17、`revert-check` 120/0、`harness-gates-check` 41/41、
`file-mutation-gate-check` 6/6、`surface-check` 18/0。

## 3. 上一轮问题修复核查

三条独立核查 lane 全部采用「基线 `2f71225` 红 → HEAD 绿」双证，不采信提交信息。

### 3.1 桥侧：22/22 fixed，0 regressed

`fix-verify-bridge` 在 `git archive 2f71225` 副本上复跑 18/18 旧反例（全红），在 HEAD 上 34 条
独立断言 + 15 个仓库离线门全绿：RW-01/CORE-05、RW-02、BF-04、RW-04、RW-05、BR-04/BF-01/H-02、
BF-02、BF-03（读前类）、BR-03/BM-02、CORE-01/02/03/04/10、BR-06/07/08、BM-02/03 逐条翻转。
正常路径负向对照（合法 symlink 工作区仍可恢复等）4/4 通过。

**残余（重要）**：BF-03 只修了「读前失败」，**「读后失败」仍静默**——见 §4 P2-1，
由 `bridge-files`、`fix-verify-bridge`、`health-crosscut` 三条 lane 独立确认同一问题。

### 3.2 插件/客户端：21/22 fixed，1 条口径过宽

`fix-verify-plugin` 用 `2f71225` 单独编译 + 同一份 HEAD 检查驱动，取得「修前红→HEAD 绿」：
session-state 12/25→25/25、child-crash 13/14→14/14、open-degrade 1/8→8/8、
process-crash 9/13→13/13、tool-call 347/365→365/365、thinking 45/51→51/51 等。

**CJ-02 判 still-broken（部分修复）**：0 live 时仍每 agent 每 4s 全速轮询、每次成功轮询仍无条件
`publish`+`registration.update`、返回体仍含全部 settled 历史。§10.1 的 fixed 标注过宽；
`e7472be` 显式恢复了「隐藏态 4s」作为**用户既定语义的权衡**（需要 4s 感知新任务），
但「每轮无条件 publish/update」是修复轮未做变更比较的欠账，两者应分开记。

### 3.3 交付/测试/文档

`fix-verify-delivery`：p8 的 D1、D2/DLV-02、L1、LP-02、DLV-12 全部 fixed；p9 的 T01/T02/T03/T04/
HP-08/H-01 fixed；p11 的 D01–D14 + HC-04 fixed。
**部分修复**：HP-05（`harness/probe.mjs`/`catalog.mjs` 仍直接使用真实 `~/.dsh`，
§10.1「真实脚本默认一次性 DSH_HOME」属过度声明）、D15（AGENTS.md「FIELD-NOTES 编号到 77」
已落后，现有 78/79 条）。
**§10.2 S08/PP-02 仍 blocked**（原因仍成立：DSH `ctx.shellEnv` 仅 `DSH_*`）；
**§10.3 全部仍暂缓**；**§10.4 A/B/C/D 无结论落地**。

## 4. 本轮 P2 发现（去重后 22 条）

按区域分组；每条给位置、证据等级、归属。P3 见各分区报告。

### 4.1 文件恢复失败路径（3 条，同一条「失败要响亮」欠账）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **BF-01 / HC-01 / N2** | `file-snapshots.js:521-548,690-700`；`server.js:2429-2433` | 实测（三 lane 独立探针） | 基线；上轮 BF-03 修复残余 | 工具成功且文件已改，但捕获/提交在**读完字节之后**失败（objects 建不了、写对象失败 ENOSPC/EACCES、父目录 realpath 失败、journal append 失败）只写 stderr、不产生 skip 行、不进回执 → `planRestore` 返回空动作 → 撤回报告「这条消息之后没有改动文件」，文件仍是改后状态。B 路径更糟：对象已写成功但 journal 行失败，该对象失去引用，之后 GC 可删掉唯一重试材料 |
| **BF-02** | `file-snapshots.js:669-682`；`index.js:111-117`；`server.js:3693-3697` | 实测 + 源码推断 | 基线 | 被跟踪的写已原子落盘（rename 完成）之后结果才被判 `isError`：撤回自己的 `settleAgentForRevert` 取消在飞编辑的竞态，或会话关闭时先清桥表再 dispose → `commit` 丢弃 pending、journal 漏行，撤回静默漏恢复。窗口窄、非系统性 |
| **BF-03** | `file-snapshots.js:526-533,936-940` | 实测 | 基线 | content-addressed 对象只 `stat` 存在性、不校验长度/哈希；截断/损坏对象被当有效 pre-image 写回用户文件并报 `restored`。可与 BF-01 的 ENOSPC 半截对象串联 |

### 4.2 撤回提示降级窗口（2 条，新引入；任务书口径 P3，按功能缺失口径 P2）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **NC-01 / RN-02** | `rewind-notice-append.ts:225-246,367-395` | 实测（`/tmp/nc-probe/degrade-wipe.cjs`：`appends:1 \| rows:0`） | 新引入（8091777） | 超时降级路径 append 后只做**一次** 1.5s 复核；宿主重建晚于 timeout+1.5s 完成时行被抹掉、不补发、无日志。`delivery-check` 的补发分支从未执行（日志无 `appending it again`），该路径目前无任何红绿证据 |
| **NC-03 / RN-01** | `rewind-notice-append.ts:340-347,367-395`；`provider.ts:1036-1055` | 实测（`race-capture.cjs`：`subscribes:0, appends:1`） | 新引入（8091777） | 句柄在 `beginRewindReport` 之后、`deliver` 之前被并发回调捕获时，不排队、不建 replacement 订阅、不复核，立即 append → conversation/both 上可能被 rebuild 抹掉 |

### 4.3 撤回与提示的其余 P2

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **BSR-01** | `revert.js:109-110`；`server.js:2662-2663` | 实测 | 新引入（88adebb） | files-only 在「当前可见对话第一条人类消息」下仍被「首条消息禁止撤回」拒绝；files 不动对话，该规则只对 conversation/both 成立。Paseo 菜单按能力位渲染，因此这条合法操作在 UI 上必现失败且理由误导。文档 files-only 节也没有这条限制 |
| **PP-02 / PP-03** | `provider.ts:1093-1101`；`docs/REWIND.md:196-204`；`AGENTS.md:261-269` | 实测（provider 侧）+ 源码推断 | 基线语义 + 文档 | canary 在宿主 rewind 的 run lock 期间以 `session.notice` 发出，被 `enqueueSessionEvent` 压进 `stagedEvents` 后随 `clearRun` 丢弃——**live 投递不可见**。但 stock 宿主会在下一次 force-hydrate 时重放 provider history，canary 又能出现（见 §6 裁决）；`REWIND.md`/`AGENTS.md` 的「时间线里根本看不到」表述不完整，会误导「canary 无效可删改」的决策 |
| **NC-02** | `client/rewind-notice-data.ts:58-60`；`provider.ts:1336-1340` | 实测（`fallback-hidden.cjs`） | 新引入 | append 失败/无 agentId 的兜底 `session.notice` 文案与 legacy 撤回行完全相同，被客户端 legacy transformer `return {items: []}` 删掉 → UI 不可见，只剩 stderr，与 provider「append failure is never silent」注释相悖 |

### 4.4 会话与进程（2 条）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **PS-01** | `session.ts:1350-1356` vs `1358-1369` | 实测 | 基线 | 子代理 history RPC 抛错只进 stderr、回放窗口缓冲帧不丢弃 → 重开时子代理行缺失且无任何用户可见原因（与同文件 `available:false` 分支已发 notice 不对称） |
| **PPR-01** | `dsh-process.ts:2558-2587,1565-1569` | 实测 | 基线 | 出站队列在流已 destroyed 时永久冻结（`write()` 返回 false 只等 drain，而 destroyed 流永不 drain）→ 请求挂 120s；`child.on("error")` 不置 `#closed`，spawn 失败后 `running` 仍为 true |

### 4.5 客户端（2 条）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **CT-01** | `tool-call-data.ts:785,1539-1544`；`tool-call.tsx:1019-1034` | 实测 | 基线（CT-02 残留） | 终端之外的正文仍硬截断 6000 且**没有恢复路径**：generic 卡既无复制也无纵向滚动（`CODE_MAX_HEIGHT=260` 无消费者）。同一类数据丢失只修了 terminal 一半 |
| **CJ-01** | `jobs-polling.ts:52,176-180,339,371`；`jobs-pill.tsx:525-551` | 实测 | e7472be 有意权衡 + 修复轮欠账 | 轮询放大未收敛：隐藏态仍 4s 全速（10 agent/60s=160 RPC，实测）、每轮无条件 publish+update（160/160）、多客户端相乘、每轮返回全部 settled job。隐藏 4s 是用户既定语义的权衡，但「无条件 publish/update」应做变更比较 |

### 4.6 交付假绿（3 条，本轮新发现）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **DLV-01** | `doctor.mjs:565-612` | 实测（doctor 全绿 + 真实 DSH 解析/启动失败） | 新发现（D1 修复未覆盖的契约层） | doctor 不校验 `.credentials.yaml` 的 DSH 文档契约（缺 `version: 1`、0644 权限、非 POSIX `refs` 键）：三种文档都让 DSH credentials 服务激活失败，doctor 却 `[ok]`+`All checks passed`+exit 0；且 doctor 自己的修复建议与 README 推荐流程恰好产出这种文件 |
| **DLV-02** | `doctor.mjs:192-199,504-563` | 实测（`dsh --dump-config` 证明补丁被跳过） | 新发现 | doctor 不校验补丁能否被 DSH 应用：补丁条目 `name` 写错时 DSH 打印 name mismatch 并静默跳过（dump 仍是 base 路由），doctor 报 `[ok] model route configured` |
| **DLV-03** | `doctor.mjs:409-419` | 实测 | 新发现 | doctor 的「profile 就绪」只判目录存在：缺 `package.json` 时 DSH 报 profile 不存在；`package.json` 不含 `dsh-paseo-bridge` bundle 时桥根本不装载（dump 中 paseo 条目 0 vs 6）——两种情况下 doctor 都全绿 |

### 4.7 补丁与测试基建（4 条）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **LP-01** | `apply-rewind-history-truncation.mjs:287-300,1581-1609` | 实测（fixture + 执行打好的类） | 基线 | 宿主耦合门不覆盖 `revert()` 参数名：上游把 `messageId` 改名（如 `async revert(id, scope)`）时锚点与 host-fields 全过、补丁照打，注入 CALL 引用未定义的 `messageId` → 每次 conversation/both 撤回抛 `ReferenceError` |
| **LP-02 残余** | `check-rewind-patch.mjs:212-225`；`apply:2806-2810` | 实测 | 修复轮部分修复 | stale 体不可重建时 checker 报 `autoPatchable=true`/exit 1、`apply --check` 说「重跑即可重建」，apply 实际 exit 3 fail closed 文件不动——门禁与实现不一致 |
| **HB-01** | `harness/rewind-notice-delivery-check.mjs:662-667`；`rewind-notice-append.ts:225-246` | 实测（删掉 `verifyAfterTimeout` 调用后仍 4/4 通过） | 测试判据 | 降级重投分支零覆盖、检查仍绿：降级场景重建远快于 300ms 超时，重投从未触发。与它要防的缺陷同形（NC-01 的静默丢行无红绿证据） |
| **HP-06** | `harness/plugin-check.cjs:22-33`；`locale-check.cjs:43-49` 等 | 实测 | 上轮 HP-06 未修 | 编译基建仍是共享 `.dbg` 无新鲜度校验：19 个手工 tsc、15 个共用 `paseo-plugin/.dbg`、参数不统一，陈旧/错参产物可让下游假绿 |

### 4.8 文档与发布线（3 条）

| ID | 位置 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|
| **DC-01** | `REWIND.md:196-203` vs `README.md:295`/`ADOPTION.md:291`/`AGENTS.md:261-265` | 文档对照 + 跨 lane 证据 | 本轮 | canary 可见性四份文档三种口径、跨 lane 结论相反（详见 §6 裁决）。**复验前别删改 canary** |
| **DC-02** | `README.md:467-479`；`paseo-plugin/package.json:3` | 实测 npm + git | 本轮 | 版本/发布线混用：README 称 package.json(0.2.16) 为唯一来源、npm latest 0.2.17，但 0.2.16/0.2.17 的 gitHead 都不是 HEAD 祖先；npm 包没有 revert.js/local-patches/jobs-pill，其 dsh-process 仍是「一进程一会话」。**npm 一行安装装不到文档描述的本仓库特性，直接发布会撞号** |
| **DC-03** | `paseo-plugin/OVERVIEW.md:7` | 文档对照 | e7472be 回退代码时漏改 | OVERVIEW 仍写 jobs "total when idle"，与 live-only 实现及 README 中英相反 |

## 5. 测试体系与验证结果

### 5.1 本轮实际执行（verify-runner，只读、离线）

**66 项（`tsc --noEmit` + 65 个 harness 脚本）全部通过、0 失败、0 环境缺失**；13 个脚本未执行
（真实模型回合、真实 daemon、真实 profile、诊断工具）；`plugin-check` 只跑 `--self-test` 离线半场；
6 个文件是基础设施不计检查。17 棵 `.dbg-*` 编译树逐棵过 `freshness()`，17/17 FRESH，无陈旧产物假绿；
真实 `~/.dsh/profiles` 执行前后无改动。

与上轮相比多个脚本断言数明显上升（`bridge-server` 34→64、`doctor` 29→37、`file-snapshot` 56→69、
`jobs-poll` 33→100、`session-request` 21→52、`rewind-notice-delivery` 新增 30），修复轮新增判据
本轮全部可复跑通过。

### 5.2 测试体系的独立判断（harness-bridge / harness-plugin）

- **T01–T04/HP-05/HP-08/H-01 的修复成立**，且修复轮新判据有归因力（红基线探针 11 红、2 红）。
- **HB-01（P2）**：降级重投分支零覆盖仍全绿（见 §4.7）——这是本轮测试体系最实质的缺口，
  与 NC-01 的静默丢行互为表里。
- **HP-06（P2）**：编译基建共享 `.dbg` 无新鲜度校验（上轮 HP-06 未修）。
- **清单登记缺口**：84 个 harness 文件中 **24 个未登记 `docs/HARNESS.md`**（19 个只在 AGENTS.md
  撤回段提及，5 个 p003 组两处都无索引）；两条新撤回检查未进 AGENTS.md 撤回必跑清单与 CI；
  唯一 workflow 只 schedule/dispatch，普通 push/PR 无门。
- **HP-01（P3）**：`route-test` 新引入假红（失败 attempt 的 failure 标记不清零，重试后成功的路由
  被判 FAILS）；attempt 文本分支与真实 packed 形状不符，是死代码。

### 5.3 「全绿」的含义

**全绿只说明离线/假桥回归面在当前 HEAD 无回归，不能当发布判据。** 发布前至少还需补跑：
`plugin-check.cjs` 全量（真实模型回合）、`route-test`/`probe`（路由与端到端）、动了流式时的
`stream-probe`、动了撤回时的 `rewind-e2e` 与 `rewind-native-check`（真 daemon + 补丁宿主）、
动了归档/桥入口时的 `archive-registry-check`，以及用户真机验收。这些都需要真实环境/授权。

## 6. 跨 lane 矛盾裁决

**canary 可见性（DC-01 / PP-02 / RN-08）**：三条 lane 给出相反口径，Lead 判定如下：

- 事实层：canary 在 rewind run lock 期间以 `session.notice` 发出，被宿主 `stagedEvents` 丢弃，
  **live 投递不可见**（provider 侧实测成立）。
- 但 stock 宿主会把 notice 放进 `PluginAgentSession.history`，下一次 force-hydrate 时**重放**，
  于是 canary 又能出现在时间线（`plugin-rewind-notice` 的 RN-08 与 `new-commits` 的宿主路径复核
  一致；`docs-consistency` 复跑 `rewind-notice-delivery-check` 观察到 truncate 失败后出现 4 条
  「撤回已生效」行）。
- 补丁宿主被 `truncateHistoryFrom` 截掉才是「看不到」的正确行为。
- **裁决**：`REWIND.md`/`AGENTS.md` 的「时间线里根本看不到」表述不完整，应按 RN-08 修正为
  「live 不可见，stock 宿主经 history 重放可见，补丁宿主被截」；**在「未打补丁宿主 + 真实 daemon」
  复验之前，不要删改 canary**。

**CJ-02 口径**：`fix-verify-plugin` 判 still-broken，`client-jobs` 判「部分修复 + 有意权衡」，
`new-commits` 判「隐藏 4s 是用户既定语义的有意偏差」。裁决：**§10.1 的 CJ-02 fixed 标注过宽**，
应拆成「隐藏 4s 轮询（有意权衡，不改回）」与「每轮无条件 publish/update（欠账，应做变更比较）」；
后者随 CJ-01 记 P2。

**BF-03 残余**：`bridge-files` BF-01、`fix-verify-bridge` N2、`health-crosscut` HC-01 三条 lane
独立复现同一问题。裁决：**成立，合并为一条 P2**（§4.1 第一行），修法应同时覆盖 capture 的
catch-all 与 commit 的 catch，把失败落成 skip/unrecoverable 并进回执。

## 7. 阴性结论（已核查，避免重复怀疑）

1. **撤回事务顺序自洽**：settle → freeze/排空 → 追加+flush → 取消/等待被撤子代理 → 重规划 →
   restore → 有条件清理；`revert-check` 120/120、`rewind-transaction-check` 17/17、
   `file-mutation-gate-check` 6/6 全绿。
2. **闸门竞态无缺陷**：freeze/drain/超时重开/abort 13/13 探针通过；prune 后重启复用序号安全。
3. **撤回提示主机制成立**：`timeline.append` 绕过 run lock、晚于 replacement、行不进 provider history、
   固定行 id 在宿主 projection 与 app reducer 两层折叠；canary 顺序未被新提交破坏
   （`revert-check` 源码位置门 + `host-contract-sim` 补丁宿主 7/7）。
4. **files scope 边界成立**：不 append/不 flush/不 prune、journal 保留、仍取消并等待被撤子代理、
   闸门释放、重复 files-only 幂等、之后 both 仍取目标消息自己的 pre-image。
5. **能力声明一致**：`session.revert.files` 在桥 revertScope/restoresFiles/successText、
   dsh-process.revert、宿主 `supportsRewindFiles→revertFiles→scope:"files"` 三处闭环，不是过度声明。
6. **协议形状无自造**：逐项核对已装 0.14 的 d.ts/实现（timeline.append、订阅四型、refetch、
   agents.list 分页、defineRpc 命名、renderer version 2、timeline identity key）。
7. **上轮 HC-01 分帧双实现已修**：桥 `transport.js` 与插件 `frame-reader.ts` 同为 256 MiB，
   被两端 harness 各自钉死。
8. **S01 并发 open、S02/S03/S04/S05/S06、C1、C2、T01–T04 均实测修好**（红→绿双证）。
9. **`e7472be` 与 CJ-01 路线 2 自洽**：无 live 任务即隐藏、只用转环、`idleLabel` 已删；
   finished 分组不是死代码（有 live 任务时仍可展开）。
10. **AGENTS.md 体积安全**：23,864 B，加用户 `~/.dsh/AGENTS.md` 10,498 B 合计 34,362 B < 65,536 B。

## 8. 建议的下一步（按优先级）

1. **修文件恢复失败路径（P2-1/2/3）**：capture 的 catch-all 与 commit 的 catch 落 skip/unrecoverable
   并进回执；restore 前校验对象长度/哈希；取消/关闭窗口不要丢已落盘写入的 pending。
   修前先把三条 lane 的探针固化为回归（现在 `file-snapshot-check` 覆盖不到读后失败）。
2. **修撤回提示降级窗口（NC-01/NC-03）**：`#watch` 在 deliver 时按当前句柄状态决定建/补建订阅；
   超时复核改为有界多次或在 replacement 到达后复核；把 `degrade-wipe`/`race-capture` 探针
   固化为 `rewind-notice-delivery-check` 的降级场景（当前补发分支从未执行）。
3. **修交付假绿（DLV-01/02/03）**：doctor 用 DSH 的 credentials/profile 真实解析器校验契约；
   补丁可应用性用 `dsh --dump-config` 式探针验证；profile 就绪校验 `package.json` 与 bundle 清单。
   同步修 README/doctor 自己的修复建议（它们目前会产出假绿文件）。
4. **修撤回与提示的 P2**：BSR-01（files-only 不套首条规则）、NC-02（兜底文案不进入 legacy 过滤）、
   PS-01（子代理 history 失败要可见）、PPR-01（destroyed 流不冻结队列）。
5. **修 jobs 轮询欠账（CJ-01）**：每轮先比较快照再 publish/update；隐藏 4s 保留（用户语义）。
6. **清单与门禁收口**：24 个 harness 脚本登记 `docs/HARNESS.md`（5 个 p003 组补索引）、
   两条新撤回检查进 AGENTS.md 撤回必跑清单与 CI、CI 补 push/PR 离线门、HP-06 编译基建统一新鲜度校验。
7. **文档口径**：canary 可见性按 §6 修正（复验前不动 canary）、OVERVIEW jobs 语义、版本/发布线
   说明、AGENTS.md FIELD-NOTES 编号、RENDER-PLAN 行号。
8. **真实环境补验（需用户批准）**：`plugin-check` 全量、`route-test`/`probe`、`rewind-e2e`、
   `rewind-native-check`、`host-contract-sim` stock 半场、真机 UI；canary 的「未打补丁宿主」复验。

## 9. 证据边界

这是对当前 HEAD 的全项目范围审查，不是所有传递依赖、所有 profile 组合或所有设备的正确性证明。
未执行/不能证明的层已逐项标注：真实模型回合、真实 daemon 撤回、Paseo App 真机 UI/动画/手势、
压力与内存峰值、iOS/Android、真实 registry 归档往返、跨 uid 文件系统攻击面、Paseo <0.14 兼容性、
macOS 签名 bundle。生成桥用字节一致性检查；大块内嵌资产不做逐字节视觉审核；第三方依赖未逐行审计。

**环境事故（如实记录）**：`plugin-process` lane 的一个探针把 `DSH_BINARY` 指向不存在路径，
`resolveBinary()` 静默回退到 `dsh`，短暂启动过真实 `dsh --profile paseo`（已 kill；仅 profile
加载 + catalog，无 sessionId、未建会话、未跑模型；已确认无残留进程、`~/.dsh/sessions` 无新目录）。
该「静默回退」本身建议记为一条 P3 发现（诊断工具不应把配置错误降级成默认路径）。

## 10. 待用户决定

1. **canary 的去留**：本轮裁决认为它「live 不可见、stock 宿主重放可见、补丁宿主被截」，
   在「未打补丁宿主 + 真实 daemon」复验之前**不要删改**；复验需要真实环境与授权。
2. **版本与发布线**：npm 0.2.16/0.2.17 与 HEAD 不同源，`npm publish` 会撞号且装不到本仓库特性；
   发布策略需要用户决策（重新定版本号/发布线，或明确 npm 包只是旧线）。
3. **S08/PP-02**（共享子进程 per-agent env）：A/B/C/D 四选项仍无结论（上轮 §10.4），本轮未推进。
4. **jobs 隐藏态 4s 轮询**：保留为有意权衡，还是投入桥侧 `liveOnly`/增量根治（上轮 §10.3 暂缓）。
5. **修复批次范围**：本轮只做审查；是否按 §8 顺序开修复轮、哪些 P2 进本轮，请用户定。

## 11. 定稿修订（2026-11-03，Lead 复核）

- P2 计数由「16」改为 22：§4 各表实际 22 行，§4.7 标题由「2 条」改为「4 条」。
- §4.7/§5.2/§8 的编译基建 `.dbg` 问题改用上轮 ID **HP-06**；§3.3 的 HP-05（probe/catalog 直接用真实 `~/.dsh`）保持原 ID。
- 「HARNESS 清单缺 24 个脚本」是 §5.2 的登记缺口，不在 P2 表内。
- §1「当前 HEAD 可发布」与 DC-02 冲突，已改为「代码层无阻断缺陷，发布线未定，不可直接发布」。
- canary 裁决经 Lead 对已装宿主 0.14.0 复核成立：`plugin-provider.js` 的 `translateNotice` 把 notice 译成 timeline 通知、`accept()` 先进 `history` 再 emit、`streamHistory()` 原样重放；补丁宿主由 `truncateHistoryFrom` 截掉；live 路径经 `agent-manager.js` 的 `stagedEvents` 丢弃。
- 修复轮计划见 `docs/audits/20261103/FIX-PLAN.md`。
