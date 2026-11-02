# bridge-files lane：文件快照 / 写入闸门 / 归属 / 重放折叠（2026-11-03）

- 审查基线：`0c82df5`（main；工作区仅未跟踪的 `V1.txt`/`v1.txt`，未触碰）。
- 环境：DSH `0.2.1-rc.5`、Node `v22.23.1`（Linux）。
- 范围：`dsh-bridge/lib/file-snapshots.js`（1122 行）、`file-mutation-gate.js`（186）、
  `snapshot-owners.js`（79）、`surface.js`（100）全文；接缝只读：`server.js` 的
  capture/commit/discard 接线、`revert()` 文件事务、`beginOwner`、`#forgetSessionState`、
  `index.js` 的 `tools/execute|post-execute|result` 接线、`revert.js`、`provider.ts` 回执消费。
- 对照：`docs/FULL-AUDIT-20261102.md` §3.1/§3.2/§10.1（p1b-snapshots）、`docs/REWIND.md`
  文件回退与 files-only 语义、`docs/FIELD-NOTES.md` 第 57/57b/57c/62/66 条、根 `AGENTS.md`
  的「失败要响亮 / 不静默降级 / 能复用上游就复用」。
- 证据等级：**实测**＝本机脚本或离线门复跑并记 exit code；**源码依据**＝当前 HEAD 或已装
  DSH 源码逐行核对；**源码推断**＝调用链推断未复现；**未验证**＝单列于 §5。
- 边界：全程只读，未改产品代码/文档/harness，未做 git 写操作，未起真实 daemon/profile/模型；
  探针都在 `/tmp/bf-audit/`（不进仓库）。**探针 exit 0 表示"行为按分析复现"，不表示产品绿**。

## 1. 方法与实跑记录

离线门（全部 exit 0，无 profile/模型副作用）：

| 命令 | 结果 |
|---|---|
| `node harness/file-snapshot-check.mjs` | exit 0，69 passed / 0 failed |
| `node harness/snapshot-lifecycle-check.mjs` | exit 0，8/8 |
| `node harness/file-mutation-gate-check.mjs` | exit 0，6/6 |
| `node harness/surface-check.mjs` | exit 0，18 passed / 0 failed |
| `node harness/rewind-merge-check.mjs`（父子归并/owner 解析） | exit 0，54/54 |
| `node harness/rewind-transaction-check.mjs`（撤回事务/闸门/回执/journal 保留） | exit 0，17/17 |
| `node harness/bridge-entry-check.mjs`（三钩子接线顺序） | exit 0，13/13 |
| `node harness/revert-check.mjs`（撤回全链路，含文件层断言） | exit 0，120 passed |

自写探针（均为独立反例/最小复现，非复制 harness）：

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `/tmp/bf-audit/probe-capture-failure.mjs` | 读后捕获失败三条路径（objects 写、journal append、父目录 realpath） | exit 0，13/13 期望复现 → **BF-01** |
| `/tmp/bf-audit/probe-corrupt-object.mjs` | 已存在但截断的 content-addressed object 被信任 | exit 0，5/5 → **BF-03** |
| `/tmp/bf-audit/probe-journal-durability.mjs` | prune/trim 重写先截断、失败即毁 journal；半行 append 粘连 | exit 0，7/7 → **BF-04** |
| `/tmp/bf-audit/probe-order-restart.mjs` | 跨重启续号、旧 journal 歧义拒绝、per-path 判定、legacy mode 身份 | exit 0，8/8 → **BR-01 修复成立** / **BF-05** |
| `/tmp/bf-audit/probe-gate-race.mjs` | 超时重开 + 排队写者 + 下一次 freeze + caller abort + 混合 abort/admit | exit 0，13/13（无缺陷） |
| `/tmp/bf-audit/probe-surface.mjs` | 撤回缝含 log-only 尾、compaction 不折、嵌套撤回、不可定位区间 | exit 0，6/6（无缺陷） |
| `/tmp/bf-audit/probe-fixes.mjs` | BR-04/祖先 symlink（改+删）、BF-02 读时序、BF-03 skip 行 | exit 0，9/9 → **三项修复成立** |
| `/tmp/bf-audit/probe-prune-reuse.mjs` | prune 丢掉高水位行后重启复用序号是否误序 | exit 0，4/4（安全） |

已装 DSH 源码核对（只读，用于判定「工具失败是否可能已改文件」与钩子顺序）：
`dsh-tools/lib/index.js:3410-3470`（execute→post-execute→result 顺序；callerCancelled 把已完成的
body 改写成 ABORTED 结果）、`dsh-fs-local/lib/index.js:512-600`（`writeFileAtomic`：临时文件 +
rename 原子发布，rename 前有 `throwIfAborted`）、`dsh-base/cordis.patch.yml:448-451`（base
profile 组合 repeat-tool-reminder，该 hook 只转发下游 block；已装包内未发现会 block 成功的
post-execute，未穷举第三方插件）。

## 2. 健康度评分：**3.5 / 5**

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 3.5 | 主路径（捕获→恢复）与上轮三个 P2 修复均实测成立；残余问题集中在失败路径（读后捕获失败、已落盘写入的取消/关闭窗口）。 |
| 健壮性 | 3 | journal 维护写非原子、维护失败只 stderr；rescue/objects 无生命周期上限；闸门在无界 flush 期间被持有。 |
| 可维护性 | 3.5 | 注释/文档密度高且与实现基本同步（`journalLine` 抽出后 prune/trim 保字段）；但 `file-snapshots.js:27-30` 与 REWIND.md:82 的「I/O 失败也记 skip」强于实现。 |
| 契约 | 3.5 | 回执字段完整且诚实（restored/deleted/skipped/alreadyAbsent/failed/unrecoverable/rescue/rescueDir/error），部分失败保留 journal 有事务检查兜底；缺口是"无 journal 行"类失败无法进回执。 |
| 性能 | 4 | per-path 串行只作用于同路径；journal 写串行、对象内容寻址去重；GC 有 pending+5min 双护栏。 |
| 安全 | 4 | 父目录 canonical 身份复核 + 逐段 lstat + 末端 lstat（绝不跟随）、journal 绝对路径/哈希校验、backup 不能穿越 objects。残余是 TOCTOU（上轮已记录暂缓）与 legacy 行只有末端检查。 |
| 测试 | 4 | 本区域离线门 69+8+6+18 且都能红；缺口是 BF-01/BF-03 两类失败路径零覆盖（见 §6）。 |
| **总体** | **3.5** | 比上轮 3.0 提升：三个 P2 修复独立复跑成立，恢复层从"会写错文件"变成"失败会拒绝/报告"。无 P0/P1。 |

## 3. 发现

> 本轮 ID 从 BF-01 重排，**与上轮 BF-xx 编号无继承关系**；carry-over 在「归属」列注明原编号。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| BF-01 | P2 | `file-snapshots.js:521-548,690-700`；`server.js:2430-2433`；`file-snapshots.js:27-30`；`docs/REWIND.md:82` | 工具成功且文件已改，但捕获/提交在**读完字节之后**失败：objects 目录建不了、对象写失败（ENOSPC/EACCES）、父目录身份 realpath 失败、journal append 失败 | **实测**（`probe-capture-failure.mjs` A/B/C：capture `ok:false` 或 commit 只 warn → journal 0 行 → `planRestore` actions=[]、unrecoverable=[] → `restore` 全空 → 文件保持 `MODIFIED`） | **上轮 BF-03 修复的残余口子**（新登记） | 这类失败只写 stderr，不产生 `skip` 行、不进回执；撤回报告"这条消息之后没有改动文件/已恢复 N 个"（`provider.ts:1106-1118` 只按回执字段判定），文件却仍是改后状态。B 路径更糟：对象已写成功、journal 行失败，pending 删除后该对象不再被任何 journal 引用，之后任一次成功恢复触发的 GC 会删除它（5 分钟宽限只是延迟），唯一重试材料丢失。 |
| BF-02 | P2 | `file-snapshots.js:669-682`；`index.js:111-117`；`server.js:3693-3697`；DSH `dsh-tools/lib/index.js:3372-3390,3438,3465`、`dsh-fs-local/lib/index.js:512-600` | 被跟踪的写已原子落盘（rename 完成）之后，结果才被判定为 `isError`：撤回自己的 `settleAgentForRevert` 取消在飞编辑的竞态；或会话关闭时 `#forgetSessionState` 先清表、`dispose` 里 post-execute 已 `ownsFileMutation()===false` | **实测**（bridge 半边：`commit(...,{isError:true})` → journal 0 行、`planRestore` 空；`probe-capture-failure.mjs` 的 B 段同形）+ **源码推断**（DSH 取消结果与 close 时序） | 新登记（既有假设"失败写没改文件"的边界） | `commit` 以 `result.isError` 丢弃 pending，注释假设"a failed write did not change the file"（`:671`）。DSH 写工具走原子写：rename 后不再有 abort 检查，随后 `callerCancelled` 可把成功 body 改写成 ABORTED，close 也会先清桥表再 dispose；这两种情况下文件已改而 journal 没有行 → 之后撤回静默漏恢复。窗口窄（rename 到结果定稿之间），非系统性。 |
| BF-03 | P2 | `file-snapshots.js:526-533,936-940` | objects/ 里已存在同名内容对象但内容损坏/截断（上次对象写到一半 ENOSPC/崩溃留下的半截文件；或外部损坏），之后再次捕获同一内容并撤回 | **实测**（`probe-corrupt-object.mjs`：预置截断对象 → capture 不修复（只 `stat` 存在性）→ 撤回 `restored=[file]`、`failed=[]`，文件被写成截断内容 `ORIG` 而非捕获时的 `ORIGINAL-CONTENT`） | 新登记 | 内容寻址对象只校验"存在"，不校验长度/哈希；`restore` 直接 `readFile(objectPath)` 写回。与 BF-01 的 B 路径可串联：一次 ENOSPC 留下半截对象 → 之后同内容捕获信任它 → 撤回把半截内容写进用户文件（rescue 有当前内容副本，可手工恢复）。 |
| BF-04 | P3 | `file-snapshots.js:1009-1019,1042-1068`（`writeFile` 先截断）、`:690-700`（append）、`:738-746`（读端容忍坏行）；`server.js:2829-2839`（只 warn） | prune/trim 重写 journal 时 ENOSPC/EIO/crash；或 append 撞上崩溃留下的半行 | **实测**（`probe-journal-durability.mjs` A：模拟 writeFile 截断后抛 ENOSPC → journal 变空 → 后续撤回 actions=[]、全空回执、文件保持改后；B：半行 + 下一行粘成一条坏行，两行一起被跳过） | 上轮 BF-06（未修） | journal 是失败重试的唯一材料，维护写却是原地 `writeFile`（先截断）；失败只 stderr，回执仍 success；append 不检查尾换行，半行会吞掉下一条完整快照。建议 tmp+rename 原子重写 + append 前补尾换行。 |
| BF-05 | P3 | `file-snapshots.js:821,842-846` | 升级后第一次撤回遇到旧 journal：同一路径两次捕获**内容相同但 mode 不同**（期间 chmod 过/权限位变化） | **实测**（`probe-order-restart.mjs` 5：`backup` 相同、mode 644/600 → `cannot prove file snapshot capture order`，整次文件撤回被拒） | 上轮 BF-09（未引入新判定，未修） | legacy 身份用 `${backup}:${mode}`；mode 与"恢复哪一版内容"无关，却让本来无歧义的旧 journal 被 fail-closed 拒绝。改为只按 `backup`（内容）判定即可，仍然保留"不同内容才拒绝"。 |
| BF-06 | P3 | `file-mutation-gate.js:157-185`；`server.js:2678,2745,2860` | 撤回拿到 freeze 后 `sessions.flush` 永不 resolve（DSH `flush` 无超时） | **源码依据**（15s deadline 只覆盖 drain；`releaseFiles` 只在回调恢复执行时才跑，flush 挂死 → root 永冻，该会话后续 tracked 编辑全部卡在 `enter`） | 上轮 BF-04（未修；本轮只修了 conversation-only 不拿闸门） | 建议给整段 `runMaintenance` 回调加 watchdog：超时释放闸门并按"恢复未完成、journal 保留"回执。 |
| BF-07 | P3 | `file-snapshots.js:980-993`（rescue 无 GC）、`:1085-1120`；`server.js:2837` | 会话从不发生"全成功且恢复文件的撤回"，或频繁撤回 | **源码依据**（`rescue/` 只增不删；`objects/` 与 journal 只在成功恢复后的 prune/trim/GC 路径清理；files-only 撤回按设计不清理） | 上轮 BF-07（未修） | 长寿命会话磁盘无上限增长；rescue 是唯一手工恢复材料，建议给保留策略（数量/时长/会话关闭时归档），而不是无界累积。 |
| BF-08 | P3 | `snapshot-owners.js:43-60`；`server.js:1679-1733`（listSessions 不排除 delegated）、`:2637,2652` | 把 `origin=subagent`/`delegationDepth>0` 的会话经 `paseo/sessions` 导入并当根会话重开，再对它做 `both` 撤回 | **源码推断**（`rootSessionFor` 只认 live 父会话 → 其编辑按 fail-open 不记 journal；撤回读该 session id 自己的空 journal → 空计划但回执 success）。Paseo 导入 UI 是否展示子会话**未验证** | 上轮 BF-08（未修） | 若可达即为静默降级。修法二选一：`listSessions` 排除 delegated 会话，或 revert 对 delegated 会话显式拒绝并说明。 |
| BF-09 | P3 | `file-snapshots.js:27-30`；`docs/REWIND.md:82` | 读文档/注释判断失败语义 | **文档对照**（"an I/O failure / 无法快照 … journal 仍记一行 skip" 只覆盖 `stat`/`readFile`/尺寸/类型；读后失败与 journal append 失败并不记 skip，与 BF-01 实测不符） | 上轮 BF-11 同类（本轮新发现的文档强于实现处） | 文档应写成"捕获前检查失败记 skip；捕获后写盘/提交失败只有 stderr，且不进回执"，或按 BF-01 修实现后再保持现文案。 |

**P0=0，P1=0，P2=3，P3=6。**

### 修复轮（6394809）核查结论

| 上轮条目 | 结论 | 独立证据 |
|---|---|---|
| BR-01 捕获序号跨重启单调 + 旧 journal 歧义拒绝 | **成立** | `probe-order-restart.mjs` 1/2/3/4 全复现：进程 2 续号 3；两条 legacy 不同 pre-image 拒绝且保留 journal；单条 legacy 可用；不同路径不互相拒绝。`snapshot-lifecycle-check` 8/8 |
| BR-04 / 上轮 BF-01 / H-02 祖先 symlink | **成立** | `probe-fixes.mjs`：改文件与"新建后删除"两种形态均 `skipped`，outside 树未被写/删，moved 原目录内容保留 |
| 上轮 BF-02 读时序（序号与读取绑定、按路径串行） | **成立** | `probe-fixes.mjs`：第一个 `readFile` 被扣住时第二次捕获不读（1 read），逆序 commit 后恢复 `BASE`；`file-snapshot-check` 69/0 |
| 上轮 BF-03 skip 行 + `unrecoverable` 回执 | **部分成立** | 预读失败（EIO/尺寸/类型）成立（`probe-fixes.mjs` + harness）；**读后失败**不成立 → BF-01 |
| `files.error` / 回执字段接入 | **成立** | `rewind-transaction-check` 17/17（含二次计划失败走 `files.error`、journal 保留、`skipped` 参与部分失败判定）；`provider.ts:1106-1165` 逐字段消费 |

## 4. 阴性结论（已核查，避免重复怀疑）

- **恢复主路径正确**：目标之后最早一次**捕获**的 pre-image 决定恢复；新建文件删除、被改文件写回、
  未触碰文件不动；逆序 commit 不误导（harness + 探针）。
- **路径身份核验有效**：父目录被移动/替换为 symlink 时改文件与删除都 `skipped` 且不跟随；
  journal 里的相对路径、`..` 穿越 backup、末端 symlink 一律拒绝（harness 69/69）。
- **闸门无竞态发现**：`freeze` 排空在飞写入、超时重开准入、排队写者在超时后被准入且下一次
  freeze 仍等它、caller abort 释放、混合 abort/admit 无泄漏、release 幂等、`size` 归零
  （harness 6/6 + `probe-gate-race` 13/13）。`enter` 的"检查 blocked → active+=1"之间无 await，
  freeze 无法插入。
- **序号机制边界正确**：prune 丢掉最高 captureSeq 行后重启复用序号是安全的——floor 取保留
  journal 最大值，被丢行已不存在，不会与保留行形成歧义（`probe-prune-reuse` 4/4）。
- **重放折叠正确**：撤回缝连同 log-only 尾巴一起折；compaction 不折人类转写；嵌套撤回折两段；
  只按 `source.kind` 判定，不做 payload 启发式（`surface-check` 18/18 + `probe-surface`）。
  无法定位区间的 replace 被静默忽略——该分支只可能由损坏/外部改写的日志触发（桥写入的 marker
  的 start/end 永远是 append 时刻的 surface 节点），且 append-only v4 日志前缀不变。
- **部分失败保留重试材料**：`failed`/`skipped`/`unrecoverable` 任一非空即跳过 prune/trim/GC；
  `alreadyAbsent` 不算失败；`files.error` 与逐文件失败分开（`rewind-transaction-check` 17/17）。
- **会话关闭清理**：`#forgetSessionState` 同时清 `fileMutationTickets`（释放 gate 租约）、
  `snapshotOwners`、`fileSnapshots.pending`（server.js:3685-3698）；RW-01 的票据泄漏已修。
- **GC 竞态护栏**：pending 里的 backup 不删 + 5 分钟新对象不删（`file-snapshot-check` 的 4 条 GC 用例全过）。
- **files-only 语义**：不 append 标记、不 flush、不 prune/trim/GC，重复 files-only 幂等，
  后续 `both` 仍按目标消息自己的 pre-image 恢复（`rewind-transaction-check` 17/17）。
- **snapshot-owners 纯函数**：缺父/死父/血缘环 fail-open 返回 undefined；`sessionId:callId`
  键与 pending 键一致（`rewind-merge-check` 54/54）。
- 未发现 `#enqueue`/`#serializeOnPath` 的 promise 泄漏或未处理拒绝（gate 的 `wait` 在
  finally 里摘 listener，journal 写链吞掉拒绝，`settle()` 永不 reject）。

## 5. 未验证项

- **真实 daemon / 真实模型 / 真实 profile 的撤回**未跑（按任务边界禁止）；BF-02 的 DSH 侧触发
  （取消落在 rename 之后、close 与在飞写入重叠）只做了源码推断，未用真实回合复现。
- **真实崩溃 / 真实 ENOSPC**未注入：BF-04 用"先截断再抛 ENOSPC"的 `writeFile` 模拟，BF-03 用
  预置截断对象模拟；两者忠实于失败形态，但不是真实磁盘满/断电。
- **多进程并发写同一 journal**未验证（依赖 DSH session write lease 单写者前提；未构造双进程）。
- **恢复期 TOCTOU**（身份复核与 `mkdir`/`writeFile` 之间替换祖先）是上轮 §10.3 明确暂缓项，
  本轮未复测。
- **非 Linux 平台**（Windows/macOS 的大小写不敏感、`NAME_MAX`、rename 语义）未验证；rescue
  命名长度只做了代码审查（上轮 57b 已记录 240+ 字符长路径未实跑）。
- **`MAX_ANCHORS=1000` 截断路径**未构造 >1000 锚点会话；截断后旧锚点的撤回会静默缺行（只
  stderr 警告），未验证其真实触发概率。
- **forward-compat**：未来 build 写入更高 `captureOrderVersion` 的行，本 build 的
  `readJournal` 会把它当 legacy，prune/trim 重写还会丢掉未知字段；降级场景未验证（非支持路径）。
- **Paseo 是否允许对 delegated 子会话发起 revert**（BF-08 可达性）未验证；同样未验证
  Paseo 导入 UI 是否列出子会话。
- **surface.js 不可定位 replace 分支**的端到端影响（损坏日志下旧行复活）未构造真实日志验证。

## 6. 跨 lane 提示

- **task-2（bridge-server-rewind）**：BF-06 的 `flush` 无界与 `releaseFiles` 释放点在
  `server.js:2745/2860`，属撤回事务边界；BF-02 的触发点之一是 `settleAgentForRevert` 取消
  在飞编辑（`server.js:2033-2046`），请与 RW-04 的 3s 窗口一并判定。
- **task-19（fix-verify-bridge）**：上轮 p1b-snapshots 的 BR-04/上轮 BF-01/H-02、BF-02 已由本
  lane 独立复跑确认 fixed；上轮 BF-03 只能算**部分 fixed**（读后失败仍静默 → 本报告 BF-01）；
  上轮 BF-04（flush）、BF-06（journal 原子性）、BF-07（rescue/objects 增长）、BF-08（子会话导入）、
  BF-09（legacy mode 身份）在 HEAD 仍未修。
- **task-16（harness-bridge）**：`file-snapshot-check.mjs` 未覆盖本报告 BF-01/BF-03 三类反例，
  建议补 3 条：objects 不可写 → 无 skip 行且回执空；journal append 失败 → 同形；预置截断对象 →
  恢复出截断内容。`snapshot-lifecycle-check` 可补"prune 丢高水位后重启复用序号"一条（当前安全，
  防回归）。
- **task-23（health-crosscut）**：本 lane 的"失败只进 stderr、不进用户可见回执"模式共 4 处：
  `file-snapshots.js:698-700`（journal append）、`:545-548`（capture 读后失败）、
  `server.js:2189-2207`（cwd 解析失败时无 journal，注释却称"会进回执"）、`:2829-2839`
  （prune/trim/GC 失败）。属该 lane 第 5 类（错误吞掉/只写 stderr）的实例。
- **docs 一致性 lane**：`docs/REWIND.md:82` 与 `file-snapshots.js:27-30` 的"I/O 失败也记 skip"
  强于实现（BF-01/BF-09）；`REWIND.md` 未记录 journal 维护写非原子与 rescue 无清理（BF-04/BF-07）。
