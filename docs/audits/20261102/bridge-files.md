# bridge-files：文件快照 / 写入闸门 / 恢复层审查

- 审查基线：`2f71225`（main，工作区干净）；对照上一次全量审查基线 `9298c28`（docs/FULL-AUDIT-20261031.md）。
- 范围：`dsh-bridge/lib/file-snapshots.js`（902 行）、`file-mutation-gate.js`（186 行，新增）、`snapshot-owners.js`（79 行）、`revert.js`（152 行）、`surface.js`（100 行）；接缝读 `server.js` 的 capture/commit/discard、`revert` 事务、`beginOwner`、`#forgetSessionState`、`index.js` 的 `tools/execute|post-execute|result` 接线，以及 `paseo-plugin/server/provider.ts` 的撤回回执。
- 证据等级：**实测**＝本机复现脚本/离线门；**源码依据**＝当前 HEAD 代码或已装 DSH 0.2.1-rc.5 源码逐行核对；**源码推断**＝调用链推断、未复现；**未验证**＝明确未取证。
- 边界：全程只读，未改任何 tracked 文件（本报告除外）、未做 git 写操作；未起真实 profile/daemon/模型回合；复现脚本在 `/tmp`（源文件未改，模块副本仅 import 行不同，已用 diff 校验还原后逐字节一致）；未做崩溃/磁盘满注入。

## 1. 结论先行

**2f71225 的两个核心修复点成立：跨重启捕获序号单调、撤回事务（freeze→计划→flush→取消/等待→重计划→恢复）在单写者前提下正确。** 离线门全绿（见 §2）且我没能推翻它们；文件层不再是上轮 BR-01/BR-02 那种「静默恢复成中间版本」的形态。

**但仍有 3 个 P2、无 P0/P1**：两条会静默恢复错文件内容（祖先目录 symlink 替换、捕获读时序），一条部分成功回执不响亮；其余 8 条 P3 属健壮性/资源/文档边界。**无阻断性健康问题。**

## 2. 修复点核查（2f71225）

| 修复点 | 核查结论 | 证据 |
|---|---|---|
| BR-01 捕获序号跨重启单调 | **成立**（在 DSH 单写者前提下）。`#nextCaptureSequence` 在 journal 写队列内读 retained journal 高水位（file-snapshots.js:333-355），`beginOwner` 在 setup 末尾刷新 epoch（:379-381，server.js:3489-3492 / 3505 / 3561 / 3587）；已核 DSH 源码：`setupAndPublish` 在 publish 前 await setup（dsh-agent-loop/lib/index.js:1915-1933），jsonl 持久化对一 id 只允许一个 active write handle（dsh-session-persistence-jsonl/lib/index.js:312）。回归：`snapshot-lifecycle-check.mjs` 8/8、`factory-ownership-order-check.mjs` 5/5。残余边界见 BF-02、BF-06。 |
| 并行写入逆序 commit | **部分成立**。`planRestore` 按 `captureSeq` 取目标后最早捕获（file-snapshots.js:597-653），`file-snapshot-check` 的 inverse-commit 用例通过；但当两次捕获**读取**文件的先后与序号分配相反时仍会选错 pre-image（BF-02，已实测）。 |
| BR-02 文件计划过早冻结 | **成立**。顺序为 runMaintenance→freeze→首计划→append marker/flush→中断+等子代理→重计划→restore（server.js:2396-2538）；`rewind-transaction-check.mjs` 7/7（含 flush 中 child commit、durability 失败、二次读失败回执、mid-rewind 写被门挡住、gate/ticket 清空）。残余边界：flush 无上限（BF-04）、3s 取消窗口是既有文档边界。 |
| 文件写入闸门 | **成立**。`file-mutation-gate-check.mjs` 6/6（drain/超时重开/跨 root 隔离/重复 freeze 拒绝/释放幂等）。残余边界 BF-04/05/10。 |
| BR-04 祖先 symlink | **未修复**。实测仍会跟随被替换的父目录 symlink 写到别的目录并报 `restored`（BF-01）。 |

跑的离线门（全部 exit 0，无 profile/模型副作用）：`snapshot-lifecycle-check` 8/8、`file-mutation-gate-check` 6/6、`file-snapshot-check` 56/0、`revert-check` 115/0、`surface-check` 18/0、`rewind-transaction-check` 7/7、`factory-ownership-order-check` 5/5。

## 3. 发现

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| BF-01 | P2 | `file-snapshots.js:422,446,676,701-702`；`docs/REWIND.md:104-105` | 文件被正常捕获后，其**父目录**被移动并替换为指向另一目录的 symlink（另一目录有同名普通文件），再撤回 | **实测**（`/tmp/br04.mjs`：`outside/file.txt` 的 `UNRELATED_OUTSIDE` 被写成 `ORIGINAL`，`restored=1, skipped=0`） | 基线已有（上轮 BR-04，未修） |
| BF-02 | P2 | `file-snapshots.js:419,422,446,639-647` | 父子代理并行编辑同一路径：先分配到 `captureSeq=1` 的一方 `readFile` 晚于另一方工具写盘完成 | **实测**（模块副本 + `readFile` 延迟注入，`/tmp/bf-repro/run.mjs`：journal `[B:2, A:1]`，`planRestore` 选 A，恢复成 `AFTER_B` 而非 `ORIGINAL`） | 基线已有（旧代码同样先分配序号后读文件；本次修复未覆盖） |
| BF-03 | P2 | `file-snapshots.js:438-445,468-471,489-491,681-691`；`server.js:2191-2194,2502-2524`；`provider.ts:963-975` | 捕获期：文件 >8 MiB、非普通文件、快照失败；恢复期：路径已变 symlink/目录，或待删文件已不存在 | **源码依据**（链路完整；provider 只对 `failed` 发时间线错误提示，`skipped` 无任何用户可见提示；`file-snapshots.js:405-408` 声称“回执会说明”与实际不符） | 基线已有（本次仅让 `skipped` 也阻止 prune，诚实回执未改） |
| BF-04 | P3 | `file-mutation-gate.js:157-178`；`server.js:2460,2533-2537` | `freeze` 拿到独占后，后续 `sessions.flush`/`restore` 挂死（DSH `SessionStore.flush` 无超时，已核 dsh-session/lib/index.js:1951-1968） | **源码依据**（15s deadline 只覆盖 drain；`releaseFiles()` 只在回调恢复执行时跑，flush 永不 resolve 则 root 永冻、该会话后续 tracked 编辑全阻塞） | **新引入**（gate 为 2f71225 新增） |
| BF-05 | P3 | `server.js:2397` vs `:2402-2406` | `scope=conversation`（不恢复文件）的撤回 | **源码依据**（无条件先拿 freeze；一个慢/挂的 tracked write 可让“只撤对话”等 15s 后失败，且没有正确性需要） | **新引入** |
| BF-06 | P3 | `file-snapshots.js:506,547-555,787-788,845-846`；`server.js:2513-2523` | prune/trim 重写 journal 时 crash 或 ENOSPC；commit append 撞上崩溃留下的半行 | **源码依据**（维护写是原地 `writeFile`（先截断）；append 不检查尾换行，半行会与下一行粘成一条坏行、两行都被 `readJournal` 跳过；错误只落 stderr，回执仍 success） | 基线已有 |
| BF-07 | P3 | `file-snapshots.js:448-458,742-755,865-901`；`server.js:2512-2523` | 会话从不发生“无失败撤回”；或失败工具留下未引用对象；或多次撤回 | **源码依据**（rescue 副本无任何 GC；objects/journal 只在成功撤回路径 prune/trim/GC；capture 先写对象、工具失败则不提交 → 未引用对象留到下次成功撤回） | 基线已有 |
| BF-08 | P3 | `snapshot-owners.js:43-59`；`server.js:1505-1559,2407` | 把一个 `origin=subagent` 的会话经 `paseo/sessions` 导入并作为根会话重开，对它做 `both` 撤回 | **源码推断**（`listSessions` 不排除 subagent 会话；`rootSessionFor` 只认 live 父会话→其编辑不记 journal；撤回读的是该 session id 的空 journal，文件层空计划但回执 success）。Paseo 导入 UI 是否实际展示子会话**未验证** | 基线已有 |
| BF-09 | P3 | `file-snapshots.js:611-636` | 旧（无 `captureOrderVersion`）journal 中同一路径两次捕获内容相同但 `mode` 不同（期间 chmod 过），升级后撤回 | **源码推断**（legacy 身份用 `backup:mode`，被误判“无法证明顺序”而整次文件撤回失败；内容其实无歧义，属 fail-closed 过度） | **新引入**（2f71225 新增判定） |
| BF-10 | P3 | `server.js:357,2086-2106,3325-3358` | 会话关闭时其 tracked 工具钩子未被派发（当前依赖 DSH `dispose` 排空并提交 started calls） | **源码依据**（`#forgetSessionState` 是“close 必须清理”的唯一清单，却不含 `fileMutationTickets`；一旦漏派发，gate 租约常驻，该 root 后续每次 freeze 等 15s 后失败）。已核 DSH abort 排空实现，异常路径未复现 | **新引入** |
| BF-11 | P3 | `docs/REWIND.md:86-88`、`:104-105` | 读文档判断行为 | **文档对照**（仍称 `captureSeq` “进程内单调”，未写 `captureOrderVersion`/旧 journal 拒绝；symlink 保证“一律跳过”与 BF-01 实测不符） | 基线文档（2f71225 未同步） |
| BF-12 | P3 | `revert.js:126-129` vs `harness/session-request-check.cjs:349-381` | 将来若声明 `session.revert.files` 能力 | **源码依据 + 实测**（`revert-check` 断言 `revertScope('files') === undefined`；假桥用例却要求 files 撤回被接受，两处语义不一致；当前能力未声明故无生产路径） | 基线已有 |

### 补充说明（按优先级）

- **BF-01 是“路径身份”而非“末端链接”缺口**：`capture` 用 `stat`/`readFile` 跟随祖先链接，`restore` 只对最终组件 `lstat`；祖先目录换掉后 `mkdir(dirname)`/`writeFile` 会跟随。修法应记录并复核捕获时的 canonical path/父目录身份，恢复前拒绝并保留 journal+rescue；只加末端 `O_NOFOLLOW` 不够。文档 `file-snapshots.js:44-47` 与 REWIND.md:104-105 的保证强于实现。
- **BF-02 是本次修复最值得补的洞**：`capture()` 在 `stat`/`readFile` 前分配序号（:419），注释说排序按“looked 的时刻”，但真实读取是异步的；父/子两个 agent 的 execute 钩子互不串行（DSH 并行工具池只序列化同一 step 的 prepare，父子是两个 step），先分配序号者完全可能后读到文件。建议序号与读取绑定（读完后分配，或按路径加互斥），回归用“读延迟注入/同文件父子并发”构造，而不是只测 commit 逆序。
- **BF-03 两个口子**：捕获期 skip/failure 连 journal 都进不去，`planRestore` 不可能知道；恢复期 `skipped` 虽进回执，但 `provider.ts:963-975` 只在 `failed>0` 时发错误通知，用户看到“撤回已生效”而 symlink/目录路径未被处理。注意 `skipped` 还混入“待删文件本就不存在”这种良性情况，桥侧用“任一 skip 就保留 journal”把两者合并了。
- **BF-04/05/10 属同一事务的边界**：建议给整段 `runMaintenance` 回调加 watchdog（超时后释放 gate 并给出“恢复未完成、journal 保留”的诚实话术），`releaseFiles` 已有 finally，但没有能触发 finally 的上限；conversation-only 可不拿文件闸门；关闭会话的状态清单应包含 ticket 表（或至少断言其为空）。
- **BF-06/07 是本地状态寿命问题**：journal 是唯一重试材料，维护写却非原子；`rescue/` 与常编辑但不撤回的 `objects/` 会无上限增长（`MAX_ANCHORS`/GC 只在撤回后触发）。可复用 DSH 的 `dsh-atomic-write`（tmp+rename）重写 journal，并给出 rescue/objects 的保留策略。

## 4. 健康度评分

| 维度 | 分 | 依据 |
|---|---|---|
| 正确性 | 3 | 跨重启序号与撤回事务核心已修；仍有两类会静默恢复错内容的边界（BF-01/02） |
| 健壮性 | 3 | 闸门 drain/超时重开/竞态处理扎实；持有期无 watchdog、journal 重写非原子 |
| 可维护性 | 3 | 注释详实但体量大、事务深嵌在 `revert` 回调里；REWIND.md 已漂移（BF-11） |
| 契约一致性 | 3 | `captureOrderVersion`/旧 journal 拒绝语义明确；skip/skipped 用户可见性、files-scope 假桥/真桥不一致 |
| 性能 | 4 | journal 写序列化、高水位每 epoch 只读一次、重放折叠线性；单文件捕获 ≤8 MiB 上限 |
| 安全 | 3 | 末端 symlink 拒绝、backup 哈希校验；祖先 symlink 与 journal 任意绝对路径未封闭（同用户威胁） |
| 测试覆盖 | 4 | 7 组相关离线门全绿且判据质量较高；缺祖先 symlink、读时序、capture-skip 回执、持有期 watchdog 用例 |

**总评：** 2f71225 把文件层从“跨重启会恢复成中间版本”修到了“编号可持久比较、事务有排空与重计划”；剩下的是读时序与路径身份两个窄但会**静默**出错的边界，以及部分成功回执仍不够响亮——不是结构性重写问题，可在文件层内局部修完。

**Top 问题：** ① BF-02 捕获读时序（并行父子同文件，静默恢复错内容）；② BF-01 祖先 symlink（静默写到别处并报成功）；③ BF-03 部分成功回执（capture skip 不可见、restore skipped 不提示）；④ BF-04 + BF-05 gate 持有期无 watchdog / 无文件需求也冻结写入；⑤ BF-06 + BF-07 journal 非原子与 rescue/objects 无上限。

**建议优先级：** 先做 3 个 P2，各配一条会红的回归（祖先 symlink 真实临时目录；读延迟注入或父子同文件并发；skip 回执/提示断言），并与真机 `rewind-merge-e2e` 一起验收。P3 建议合成一个维护批次：事务 watchdog + conversation-only 不取闸门 + ticket 表进 close 清单；journal 改原子写；rescue/objects 保留策略；REWIND.md 同步。BF-08/09/12 属窄边界，登记即可。

**是否有阻断性健康问题：** 否。无 P0/P1；最坏情况是 `both` 撤回在窄触发下恢复错内容/漏恢复，但 journal+rescue 材料保留、失败路径不 prune，且本轮修复已让 `both` 的失败回执比上轮诚实。

## 5. 未验证清单

1. BF-08 可达性：Paseo 导入对话框是否实际列出 `origin=subagent` 的会话（未起真机/真 daemon 验证）。
2. BF-04 持有期挂死的真实触发：未做 flush/restore 挂起或磁盘故障注入，仅核到上限缺失与 DSH flush 无超时。
3. BF-10 关闭时钩子派发：DSH 源码显示 abort 会排空 in-flight 并提交 started calls（dsh-agent-loop/lib/index.js:506-643），异常路径未复现。
4. BF-06 崩溃/ENOSPC 窗口：未做故障注入，结论来自写入方式源码（原地 `writeFile` + `appendFile`）与读侧跳过坏行行为。
5. 跨进程写租约：只核了 DSH 源码“一 id 一 active write handle”，未做双进程实测。
6. 真实模型回合、真机撤回、重启后真实 profile 行为：本轮只读约束下未跑（上一轮同样未跑；相关 e2e 需 token）。
