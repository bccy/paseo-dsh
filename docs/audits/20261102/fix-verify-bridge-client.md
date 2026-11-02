# BR/C/D/L/T 修复核查（2026-11-02）

- 审查对象：`main` HEAD `2f71225`（工作区干净），对照 [FULL-AUDIT-20261031](../FULL-AUDIT-20261031.md) §3.3/§3.4 与 [audits/20261031](../20261031/) 的原始描述。
- 方法：**不采信提交信息**。逐条读当前代码（file:line）+ 在当前 HEAD 上实跑回归/反例；文件级归属用 `git diff 9298c28..HEAD` 对账，反例用 `git archive 2f71225` 的独立副本执行。
- 结论：**BR-01、BR-02 已修复**（2f71225，有反例翻转与新增回归双证）；其余 16 条全部**未修复**——不是「没时间改」，而是源文件在基线后 0 改动，且原始反例在当前 HEAD 上逐条仍复现（见 §2）。
- 范围外（仅记录，不裁决）：`de4ba8c`=S01 并发 open、`cedeaf3`=usage 上报，不属本 lane。

## 1. 逐条状态

状态判据：已修复 = 反例在当前 HEAD 不再成立且有针对该缺陷的回归通过；未修复 = 反例仍成立/代码路径未变。file:line 均为 `2f71225` 当前行号。

| ID | 级别 | 当前状态 | 证据 file:line | 回归结果 | 残余风险 |
|---|---|---|---|---|---|
| BR-01 | P1 | **已修复** | `dsh-bridge/lib/file-snapshots.js:262`(`#captureSequence`)、`:271`(`#sequenceRoots`)、`:312-355`(`#nextCaptureSequence` 从 journal 高水位续数)、`:365-367`(`settle`)、`:369-381`(`beginOwner`)、`:419`(capture 先分配序号)、`:496-499`(写入 `captureOrderVersion:1`)、`:583-653`(planRestore 按 captureSeq 排序 + 旧行歧义 fail-closed 拒绝)；接线 `dsh-bridge/lib/server.js:3492,3505,3561,3587` | `snapshot-lifecycle-check.mjs` exit 0（8/8）；原始反例（`reproductions/bridge-extra-repro.mjs:40` 断言「恢复成中间版本」）在当前 HEAD **断言失败**：`actual='ORIGINAL'`（期望缺陷值 `AFTER_FIRST_EDIT`） | ① 同一 root journal 之外不保证跨 journal 可比（设计如此：排序只按 path 决定）；② 旧 journal 一旦同 path 出现两个不同 pre-image 的 legacy 行，撤回整体报错（对话不动），错误文案给出了 path 与「journal and backups retained」但未给出 rescue/journal 目录，运维定位需自己拼路径 |
| BR-02 | P1 | **已修复** | `server.js:2396`(`runMaintenance`)、`:2397`(`fileMutationGate.freeze`)、`:2407`(首次 plan)、`:2460-2466`(append+flush+durable 校验)、`:2473-2474`(取消并等待被撤子任务)、`:2483`(flush/settle 后**重算** plan)、`:2502-2524`(restore 后有 failed/skipped 才不 prune)、`:2533-2537`(finally 释放闸门)；闸门 `dsh-bridge/lib/file-mutation-gate.js:157-186`（freeze 超时 15s 且失败必 unblock）；hook 接线 `dsh-bridge/lib/index.js:85-95,99-107` | `rewind-transaction-check.mjs` exit 0（7/7：flush 期间 child 提交被纳入、plan 确实算两次、durability 失败保留文件/journal、日志提交后读 journal 失败报部分结果、gate 始终释放）；`file-mutation-gate-check.mjs` exit 0（6/6） | ① `settleDelegatedWork` 只有 3s（`server.js:2312-2326`），超时只打 stderr 就继续：3s 后仍存活的 child，其后续 tracked write 在闸门释放（restore 后）才落地，属「恢复之后又写」的已知边界；② 窄窗口：child 的 `post-execute` 释放 ticket 之后、`commitFileTool` 入队之前若落在 re-plan/settle 之后，该行可能既未恢复又被 prune（未构造出实测，标**未验证**） |
| BR-03 | P2 | **未修复** | `server.js:1872-1889`（`observeDelegatedTurn` 仍取 `latestHumanAnchor(root)`）、`:1902-1906`（`snapshotAnchorFor` fallback 同）；`dsh-bridge/lib/child-anchors.js` 0 改动 | 反例实测（当前 HEAD 副本）：父派发锚 10，根新消息 20 后孙任务被记成 20；`withdrawnSince(20)`=`["grandchild"]` | 撤无关新消息会取消并回退本属旧指令的孙任务；无祖先/环/双 root 的 fail-open 未变 |
| BR-04 | P2 | **未修复** | `file-snapshots.js:669-702`（restore 仅 `lstat` 末端组件 `:676`，非普通文件即 skip `:681-686`，随后 `mkdir`+`writeFile` `:701-702` 跟随祖先链接）；全文件 grep `realpath|canonical` **0 命中**，捕获时未记录父目录身份 | 反例实测：workspace 捕获后换成指向 outside 的 symlink，恢复把 `outside/file` 从 `UNRELATED_OUTSIDE_FILE` 改成 `WORKSPACE_ORIGINAL`，`restoredCount=1, skippedCount=0` | 私有同用户文件系统行为，未证明 OS 越权；头部注释 `Trust boundaries` 的「refuses symlinks」仍只覆盖末端，注释强于实现 |
| BR-05 | P2 | **未修复** | `server.js:3606-3614`：`if (wanted && planMode !== undefined) planMode.set(handle.agent, true)` —— queued `false` 仍被删除后丢弃 | 反例实测：`planSet({active:false})` 回 `{outcome:"queued"}`；resume 后 `activeAfterResume=true`，`setCalls=[]` | build 模式下打开持久 plan=true 会话，后端仍 plan；错误路径不报「未兑现」 |
| BR-06 | P2 | **未修复** | `dsh-bridge/lib/mcp-gateway.js:547`（`async execute(args)` 不接 exec/signal）；`mcp-http.js:136-163`（仅内部 timeout controller）；`mcp-stdio.js:284-305`（pending 只有 timeout，无取消通知）；三个元工具均未传播 signal | 反例实测（loopback）：exec.signal abort 后 `requestAborted=false`、`completedAfterAbort=true`，返回 `SIDE_EFFECT_COMPLETED` | 取消回合后 MCP 调用继续等待并可能继续远端动作/落盘；不能撤销已执行远端业务（已知），但连请求放弃都没做 |
| BR-07 | P2 | **未修复** | `mcp-gateway.js:543`（`projectContent(server,target,result.content)`）、`:558-568`（返回 `{server,tool,content,images}`，无 structuredContent）；输出 schema 无该字段 | 反例实测：服务返回 `{content:[],structuredContent:{answer:42}}` → gateway `content:""`、`structuredContent: undefined`，42 丢失 | 模型认为成功但拿不到主要结果；混合文本+结构时结构字段同样丢失 |
| BR-08 | P2 | **未修复** | `dsh-bridge/lib/image-host-path.js:85-87`（可预测 `TMPDIR/paseo-dsh-attachments-<uid>`）、`:120-142`（`copyBeside`：staging 名 `<target>.<pid>.tmp` 可预测，`copyFileSync` 写 staging 会跟随预置 symlink；只校验 target 尺寸） | 反例实测（隔离 TMPDIR 子进程）：预置 `digest.jpg.<pid>.tmp -> victim`，结果 `victim` 被改写为 `ATTACHMENT_BYTES`，`outputEndsInJpg=true` | 私有同用户文件系统行为；同尺寸替换仍可被复用（代码注释自认的残余） |
| C1 | P2 | **未修复** | `paseo-plugin/client/tool-call-data.ts:1236`（接收 `error?: unknown`）但 `:1259` 只读 `status === "failed"`；`:1296-1317` 仍取请求内容/diff；输出合同 `:1463-1510` 无错误字段；`paseo-plugin/index.client.tsx` schema 无错误字段；`tool-call.tsx` 只用图标表达失败 | 反例实测（真实编译 TimelineBuilder→mapper）：write/edit `errorSurvives=false`（body 仍是请求内容 / diff），bash 正对照 `true` | 失败原因在客户端彻底消失；用户无法判断为何失败；无法保真时应交宿主渲染（未做） |
| C2 | P2 | **未修复** | `paseo-plugin/client/inline-thinking.tsx:56-69`：`useGrowing` 在 `grew` 时 `setGrowing(true); return`，依赖 `[text,phase]` | 反例实测：`a/streaming` → `ab/complete` 同帧 `shimmerActive=true`；需再发生一次 phase 变化才 false | 末帧增长+complete 时扫光/预览不落定，原生动画持续；具体是否每个回合触发取决于宿主末帧时序（未验证真机） |
| D1 | P2 | **未修复** | `paseo-plugin/lib/doctor.mjs:455-467`（`routeAt` 后 `active.slice(routeAt)` 一直扫到 EOF 取 provider/model）、`:491-501`（`credentialText.slice(refsAt)` 到 EOF 取凭据、非空仅看 `\S`）；解析出的 YAML 对象仍被丢弃 | 反例实测（真实 `runDoctor`，沙箱 DSH_HOME）：`quoted-empty-route`、`route-from-later-block`、`quoted-empty-credential`、`comment-only-credential`、`credential-after-refs-block`、`disabled-route` 全部 `exitCode=0, allPassed=true`（含 positive-control 同形） | 直接违背「doctor 全绿再启动」；disabled 条目仍被当作有效路由 |
| D2 | P2 | **未修复** | `paseo-plugin/lib/probe-provider.mjs:144-148`（`isVerdict`：仅排除 408/429，其余 4xx 一律算能力结论）、`:314-347`（据此输出「needs compat.supportsDeveloperRole: false / reasoningEfforts: false」建议） | 反例实测：baseline 200 后 401/402/403 → `exitCode=0, advisesDisableReasoning=true, developerRejected=true`；429 对照 `exitCode=1, unknownReasoning=true` | 临时鉴权/额度/网关拒绝会被固化成永久配置降级 |
| L1 | P2 | **未修复** | `local-patches/apply-rewind-history-truncation.mjs:1332-1360`（`locateRewindCallRegion` 的 `end = source.lastIndexOf("\n", close)+1`，即 bridge 调用结束到 revert 方法末尾全部纳入替换区）、`:1372-1400`（`rebuildRewindCall`）；文件 0 改动 | 反例实测（纯字符串函数）：CALL 后追加 `this.upstreamCleanupAfterRewind();`，重建后 `unrelatedTailPresentAfter=false`，且结果仍能解析 | stale 重建会静默删掉其它补丁/上游新增 tail 语句；当前干净 npm 升级走 clean 分支，不必然触发 |
| T01 | P2 | **未修复** | `harness/route-test.mjs:135-136`（`verdict = result.text ? 'WORKS ' : 'FAILS '` 忽略 `result.failure`）；全文件无「全 FAIL 则非零」逻辑（仅无 routes 时 `process.exit(2)`） | 反例实测：`text="partial answer", failure="fatal turn error"` 仍输出 `WORKS`；全部 FAILS 时 `exitCode=0` | 失败回合可被判为可用；CI 无法据此设 gate |
| T02 | P2 | **未修复** | `harness/tools.mjs:73`（`request('initialize',{cwd})` 不带 sessionId，而 `:76` 的 prompt 带 `SESSION_ID`） | 反例实测：真实桥拒绝 `paseo bridge is not initialized for session tools-synthetic-session` | 诊断工具自身制造「工具不可见」假故障；另有 timer 不清理/继承真实 profile 的既有问题 |
| T03 | P2 | **未修复** | `harness/plugin-check.cjs:470`（先 `.filter(assistant_message)` 再 `projectTimelineLikePaseo`） | 反例实测：真实序列 `assistant→reasoning→assistant` 完整输入得 2 条 assistant 行，assistant-only 过滤后 1 条，`harnessPredicatePasses=true` | 邻接/碎片判据可被自己的预过滤满足，证明不了宿主投影不碎片 |
| T04 | P2 | **未修复** | `harness/plugin-check.cjs:359`（提示词要求回 `IMAGE-SEEN`）、`:499-508`（`/image|图片|…/i` 匹配非 user 行文本） | 反例实测：`imageBlocksSent=0` 时合成 assistant 回复 `IMAGE-SEEN`，`imageEvidencePredicatePasses=true` | 该判据证明不了附件抵达；无图负对照缺失 |

## 2. 实测记录（全部在当前 HEAD 上执行）

### 2.1 现有回归（全绿，但见 2.2 的覆盖边界）

| 脚本 | exit | 关键断言 |
|---|---|---|
| `snapshot-lifecycle-check.mjs` | 0 | 8/8：跨实例续数、并行逆序 commit、beginOwner 重读、旧 journal 拒绝、单 pre-image 可用、跨 path 不拒绝 |
| `rewind-transaction-check.mjs` | 0 | 7/7：flush 期间 child 提交被纳入、plan 算两次、durability 失败保留证据、日志提交后读 journal 失败报部分结果、mid-rewind 写入等待闸门、闸门释放 |
| `file-mutation-gate-check.mjs` | 0 | 6/6：freeze 排空、abort 不泄漏、超时重开、root 独立、二次 freeze 拒绝、release 不孤儿 |
| `file-snapshot-check.mjs` | 0 | 56/56 |
| `rewind-merge-check.mjs` | 0 | 49/49（父子/孙归并、断链 fail-open） |
| `revert-check.mjs` | 0 | 115/115（规划/wiring/共享进程接线） |
| `surface-check.mjs` | 0 | 18/18（只折撤回缝、compaction 保留） |
| `bridge-assets-check.mjs` | 0 | 2/2：内嵌桥 21 文件与源码逐字节一致（2f71225 已重新生成） |
| `probe-check.mjs` | 0 | 21/21（200+error / HTML / 泄密 / 429 / 全无结论非零） |
| `doctor-check.mjs` | 0 | 29/29（旧用例集） |

`reproductions/run.py --ref 2f71225` 的四个前置门（DSH 契约、内嵌桥新鲜度、`tsc --noEmit`、CJS 编译）全部通过——同时证明 2f71225 的桥资产与当前源码一致。

**这些绿不能解释为 D/C/T 条目已修复**：D1/D2/C1/C2/T01–T04 的源文件在 `9298c28..HEAD` 间 0 改动，上述检查的用例集与这些缺陷不相交（doctor-check 没有空引号 route / 禁用 default-model 用例；probe-check 没有 baseline-200 后 401/402/403 用例；tool-call-check 只查 failed/status；thinking-check 不断言组件状态落定；route-test/tools/plugin-check 的判据本身即缺陷）。

### 2.2 原始反例在当前 HEAD 上的复现（`run.py --ref 2f71225`，独立副本）

| 反例 | exit | 观察 |
|---|---|---|
| bridge（BR-01 断言在脚本第一个 check 处） | **1** | 断言失败：`actual='ORIGINAL'`（缺陷时应为 `AFTER_FIRST_EDIT`）→ **BR-01 缺陷不再成立** |
| harness（T01–T04） | 0 | T01 partial+failure→WORKS、全 FAIL exit 0；T02 真桥拒绝未 initialize 的 prompt；T03 过滤后 1 行 vs 真实 2 行；T04 0 image block 仍通过 |
| doctor（D1） | 0 | 六类畸形配置全 `allPassed=true` |
| thinking（C2） | 0 | `ab/complete` 同帧 shimmer=true |
| tool-errors（C1） | 0 | write/edit `errorSurvives=false`，bash 正对照 true |
| probe-auth（D2） | 0 | 401/402/403 exit 0 且建议关思考；429 对照正确 |
| patch-tail（L1） | 0 | tail 语句被删、结果仍可解析 |

BR-02 的原始反例与 BR-01 同脚本，BR-01 断言先失败即中止，故单独以 `rewind-transaction-check.mjs`（专门覆盖该时序，7/7）与代码顺序复核作为修复证据。为取 BR-03–08 的独立实测，在 `/tmp` 证据目录复制脚本、仅剥离 BR-01/BR-02 两段断言后重跑（未改仓库），结果：

| 反例 | 实测（当前 HEAD） |
|---|---|
| BR-03 孙任务归属 | 父锚 10、根最新 20 → 孙任务 anchor=20；`withdrawnSince(20)=["grandchild"]` |
| BR-04 祖先 symlink | outside 文件被改为 `WORKSPACE_ORIGINAL`，restored=1 skipped=0 |
| BR-05 queued plan-off | resume 后 active 仍 true，setCalls=[] |
| BR-06 取消 | abort 后请求未取消、返回 SIDE_EFFECT_COMPLETED |
| BR-07 structuredContent | `{answer:42}` 丢失，content="" |
| BR-08 图片 staging | victim 被改写为 ATTACHMENT_BYTES |

## 3. 本次新发现

| ID | 严重度 | 位置 | 说明 |
|---|---|---|---|
| N1 | P3（测试基建，非产品） | `docs/audits/20261031/reproductions/bridge-extra-repro.mjs:40`、`reproductions/run.py:152-160` | 该复现 runner 是 all-or-nothing：BR-01 修复后脚本在第一个 assert 处 uncaught 退出，BR-02–08 的断言不再执行，case 只按 exit code 判「反例确认」。用它做逐条修复回归会得出「bridge 全组未修」或「无法判定」的误导结论；本次需手工剥离断言才能继续取证。建议改成逐条 try/catch 记录或拆文件 |
| N2 | P3 | `dsh-bridge/lib/server.js:2396-2400` | BR-01 的 fail-closed 拒绝（旧 journal 歧义）从 `planRestore` 抛出后直接成为 revert 的 `request.failed` 文案（含 path 与「journal and backups retained」），但**不含** rescue/journal 的实际目录，用户/运维需自己定位。建议文案带上 `rescueDir`/`journalPath`（该信息在后续分支里已经取得到） |

不登记为缺陷但需留意：`file-mutation-gate` 的 15s freeze 超时会 throw（revert 整体失败、对话未动），这比「静默用旧计划恢复」正确；`file-snapshots.js:565-567` 把非 1 的 `captureOrderVersion` 当作 legacy 处理（fail closed）。

## 4. 总评

**两个 P1（BR-01 跨重启快照序号、BR-02 撤回漏在飞子写入）在 2f71225 中确已修复**，且有「反例翻转 + 新增回归」双向证据；修复范围之外的 16 条（BR-03–08、C1/C2、D1/D2、L1、T01–T04）全部仍成立——它们的源文件在基线后没有任何改动，原始反例在当前 HEAD 上逐条复现，现有 400+ 条回归绿不能覆盖这些缺口。下一步应按原审查的分层顺序继续修：MCP 语义（BR-06/07）与文件恢复身份（BR-04/08）→ 客户端/自检语义（C1/C2/D1/D2）→ 维护护栏（L1）与测试判据（T01–T04）。
