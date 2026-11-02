# 文档与实现一致性审查（docs-consistency，2026-11-03）

- 审查基线：`0c82df5`（main；工作区只有未跟踪的 `V1.txt` / `v1.txt` 与本轮报告目录 `docs/audits/20261103/`，未改动任何 tracked 文件）
- 环境（本机实测）：Node v22.23.1、DSH `0.2.1-rc.5`（`node harness/dsh-api-contract-check.mjs` → `DSH version: 0.2.1-rc.5 (8 package(s) loaded, 0 failed)`）、Paseo `0.14.0`
- 性质：fresh 上下文、独立只读审查；不采信其它 lane 与本仓提交信息的结论，文档事实以源码/实测重新核对
- 证据等级：**【文档对照】**＝文档互相比对；**【源码对照】**＝读产品代码核对文档断言；**【实测】**＝本轮命令跑出并记 exit code / 输出；**【跨 lane】**＝其它 lane 报告里的独立证据（仅作旁证，已注明出处）
- 禁项遵守：未改产品代码/文档/harness（本报告除外）、未做 git 写、未起真实 daemon/模型、未读写真实 `~/.dsh` profile、未装包；离线脚本用各自的临时目录/一次性 `DSH_HOME`

## 1. 范围与方法

### 1.1 逐份通读的文档

| 文档 | 行数 | 通读方式 |
|---|---:|---|
| `README.md` / `README.en.md` | 517 / 604 | 全文逐节读，中英对照 |
| `AGENTS.md`（仓库根，整份注入 DSH 会话） | 307（23,864 字节） | 全文逐节读，逐条技术断言回源码核对 |
| `docs/ADOPTION.md` | 419 | 全文 |
| `docs/FIELD-NOTES.md` | 2,793 | 全文分轮扫读 + 逐条核对「已知限制/最近三轮/编号」 |
| `docs/HARNESS.md` | 369 | 全文，逐脚本与 `harness/` 实际文件做集合差 |
| `docs/REWIND.md` | 413 | 全文，逐条对照 `provider.ts` / `rewind-*.ts` / `dsh-bridge/lib/*` / local-patches |
| `docs/IMPL-CONTRACT.md` / `docs/ONE-PROCESS-MULTI-SESSION-PLAN.md` / `docs/PLAN-REWIND-NATIVE.md` / `docs/PROGRESS-REWIND-NATIVE.md` / `docs/0.12-ADOPTION.md` | 165 / 327 / 677 / 317 / 52 | 头部状态标记 + 现在时陈述抽查 |
| `docs/RENDER-PLAN.md` | 275 | 全文，Phase 4「仍未做」与行号锚点逐条核对 |
| `docs/FULL-AUDIT-20261020.md` / `20261029.md` / `20261031.md` / `20261102.md` | 185 / 265 / 152 / 288 | 结论、版本基线、修复结果段逐条对照 HEAD |
| `docs/plantree/**`（20 个 md）、`docs/preview/**`、`docs/research/table-labels.md` | — | 状态/基线/行号引用抽查 |
| `templates/cordis.patch.yml`、`install.sh` | 80 / 266 | 全文对照 README/ADOPTION 与 bootstrap/install 实现 |

### 1.2 取证命令（只读）

```bash
git rev-parse --short HEAD && git status --short
wc -c AGENTS.md                                  # 23,864 字节
npm view paseo-dsh version / dist-tags           # 0.2.17 / latest=0.2.17
npm view paseo-dsh@0.2.16 gitHead / @0.2.17 gitHead   # 90890d1… / f1830b6…
git merge-base --is-ancestor <npm gitHead> HEAD  # 两者均 false
node harness/dsh-api-contract-check.mjs          # 12/12，8 package(s)
node harness/bridge-assets-check.mjs             # 2/2
node harness/rewind-notice-delivery-check.mjs    # 30/30（含 canary 行在时间线里的证据）
node local-patches/apply-rewind-history-truncation.mjs --check   # 补丁在位（rewind+turnId）
diff 仓库 local-patches 脚本 vs ~/.paseo/local-patches 副本
git ls-tree upstream/main …                      # 上游 main 的能力/文件面
```

源码对照：`paseo-plugin/server/{provider,session,timeline,dsh-process,bootstrap,rewind-canary,rewind-notice-append}.ts`、`paseo-plugin/client/{jobs-pill,jobs-polling,locale,rewind-notice*,tokens,tool-call}.ts(x)`、`paseo-plugin/index.client.tsx`、`paseo-plugin/shared/{jobs,rewind-notice}.ts`、`dsh-bridge/lib/{server,revert,mcp-http,paseo-system-envelope}.js`、`paseo-plugin/lib/doctor.mjs`。

## 2. 健康度评分：**3 / 5**

| 维度 | 分 | 理由 |
|---|---:|---|
| 当前事实正确性 | 3 | 上一轮 D01–D15 的多数修复成立（进程模型、图片输出、Node 20.4、八包、24 方法、locale 说明都已对齐）；但**版本/发布线**仍把两条不同的发布线混在一份 README 里，且更新日志收录了本仓库代码里不存在的 0.2.17 行为 |
| 用户可见能力声明 | 3 | README/包 README 的 jobs 语义已改 live-only，但 `paseo-plugin/OVERVIEW.md`（paseo.sh 插件页文案）仍写 "total when idle"；撤回与 files-only 能力未进任何能力清单 |
| 新语义同步（本轮重点） | 2 | `e7472be..HEAD` 的撤回提示（timeline.append 完成报告 + 胶囊）与 files-only **只写进 `docs/REWIND.md` / `docs/HARNESS.md`**；README/README.en/ADOPTION/OVERVIEW/AGENTS 仍是旧 canary 口径，且 REWIND 的「实测修正」与 README/ADOPTION/AGENTS 互相矛盾（跨 lane 对哪边成立也有相反结论） |
| 可维护性/索引 | 3 | HARNESS.md 引用 58 个脚本无死引用、两个新检查条目准确；但 84 个 harness 文件中 24 个未登记在 HARNESS.md（19 个只在 AGENTS.md、5 个 p003 两处都没有），与 AGENTS.md「逐脚本清单在 HARNESS.md、新增也登记到那里」的规则不符；撤回链在两份文档里是两套清单 |
| 历史文档纪律 | 3 | 冻结类文档都带「历史文档，内容保持当时原样」标记；但 `0.12-ADOPTION.md`、`plantree/baseline/README.md`、`FULL-AUDIT-20261102.md` §10.1 里仍有现在时的状态声明已被 HEAD 推翻 |
| AGENTS.md 体积预算 | 4 | 实测 23,864 字节；与用户 `~/.dsh/AGENTS.md`（10,498 字节）合计 34,362 字节，距 65,536 字节预算余量约 30.7 KB，**当前无风险**；仍应遵守「长清单放 docs/」 |

**一句话总评：** 文档主体（架构、进程模型、图片、Node/DSH 版本要求、桥依赖数、命令入口）已与实现对齐，上一轮 P2 的事实漂移基本修复；本轮扣分集中在**新撤回语义没有同步到用户文档**、**canary 文档内部矛盾**、**版本/发布线未区分**和**harness 清单登记缺口**——没有 P0/P1 级误导，但「撤回提示怎么工作」这一块现在同时存在三种口径，不能直接当结论使用。

## 3. 发现列表

**计数：P0 0 / P1 0 / P2 3 / P3 15。**

### 3.0 上一轮 D01–D15 复核（对照 `docs/audits/20261102/docs-consistency.md`）

| ID | 上轮级别 | HEAD 复核 | 证据 |
|---|---|---|---|
| D01 OVERVIEW 图片反向声明 | P2 | **已修**：`paseo-plugin/OVERVIEW.md:9` 现写 "Images work both ways"，与 `image-host-path.js` + `timeline.ts` 图片行一致 | 【文档对照】【源码对照】 |
| D02 ADOPTION「桥每会话新起」 | P2 | **已修**：`docs/ADOPTION.md:34-38,388-395` 与 `README.md:277-285` 均写一连接共享一个子进程 | 【文档对照】【源码对照】 |
| D03 npm 最新 0.2.9 | P2 | **已修**：README/en/包 README 均写 0.2.17 并标历史注记 | 【文档对照】【实测 npm】 |
| D04 仓库 0.2.11/未发布 | P2 | **数值已修**（`paseo-plugin/package.json:3` = 0.2.16、npm latest = 0.2.17）；但「两条发布线」问题仍在，见 DC-02 | 【实测】【文档对照】 |
| D05 五个内部包 | P3 | **已修**：README/en/包 README/OVERVIEW 均写八个；契约检查实测 8 package(s) | 【实测】 |
| D06 Node 18 vs 22 | P3 | **已修**：README/en/包 README/OVERVIEW 统一为 Node ≥ 20.4，且 `AbortSignal.any` / `Symbol.dispose` 使用点核对成立 | 【文档对照】【源码对照】 |
| D07 客户端 locale 口径 | P3 | README/en **已修**（新增「服务端文案口径 vs 客户端默认 zh-CN」段）；`docs/RENDER-PLAN.md:105` 未修，见 DC-08 | 【文档对照】【源码对照】 |
| D08 更新日志缺 0.2.17 | P3 | **已补**（`README.md:479`、`README.en.md:566`）；但该条目描述的代码不在本仓库，见 DC-02 | 【文档对照】【实测】 |
| D09 ADOPTION 8 方法 | P3 | **已修**：`docs/ADOPTION.md:88-92` 写 24 个；`server.js` 的 `handleRequest` 实测 24 个 `case` | 【源码对照】 |
| D10 行号锚点 | P3 | REWIND 部分**已修**（改为符号名）；`docs/RENDER-PLAN.md:260`（`:916`，实际 1110）未修，`plantree/003/excluded.md` 另有漂移，见 DC-08/DC-14 | 【源码对照】 |
| D11 FIELD-NOTES「13 种事件只映射 4 种」 | P3 | **已修**：已知限制改为 9 种 durable 事件 | 【文档对照】 |
| D12 能力清单滞后 | P3 | jobs/goal-workflow/审批卡/systemPrompt 已进 README 能力表；**撤回（含 files-only）仍不在任何能力清单**，见 DC-12 | 【文档对照】 |
| D13 supportsDeveloperRole 条件性 | P3 | ADOPTION **已修**（`:177-180`）；`templates/cordis.patch.yml:35-40` 仍写 "harmless if you do not"，见 DC-15 | 【文档对照】 |
| D14 AGENTS「Paseo 0.15 已修 #4667」 | P3 | **已修**：`AGENTS.md:82` 现写「当前 #4667 仍 open，补丁仍在用」 | 【文档对照】 |
| D15 FIELD-NOTES 编号体系 | P3 | **部分回归**：`AGENTS.md:59` 写「编号到 77」，FIELD-NOTES 实际已到 **79**（78/79 由 `aa72484`/`8091777` 新增），见 DC-05 | 【文档对照】 |

### P2 发现

#### DC-01（P2）撤回提示（canary）的可见性：四份文档三种口径，跨 lane 结论相反

- **位置**：`docs/REWIND.md:9`、`:181-194`、`:196-203`（实测修正）、`:317-322`、`:398-401`；`README.md:295`；`README.en.md:337`；`docs/ADOPTION.md:291`、`:295-299`；`AGENTS.md:261-265`
- **文档原文（互相矛盾的两组）**：
  - A 组（README/ADOPTION/AGENTS/REWIND 设计段）：「底部那条『撤回已生效』提示一闪而过」（补丁宿主）；「原版宿主会留下它，告诉用户执行 Reload agent 或重开会话」；REWIND「真机验收」甚至要求两种宿主各验一次（`:398-401`）。
  - B 组（同文档 REWIND「实测修正」`:196-203`）：「canary 的交付层在真实 daemon 上并不成立……时间线里根本看不到它——补丁宿主上『一闪而过』、原版宿主上『留在底部』这两种表现都观察不到」。
- **实际（源码 + 本轮实测 + 跨 lane）**：
  - 代码里 canary 仍是 `session.notice`，在 `request.completed` 前发出（`provider.ts:1093-1102`），`scope === "files"` 不发；「Reload agent」文案只存在于 `rewind-canary.ts:62-63`；完成报告（`shared/rewind-notice.ts`）**不含任何刷新指引**——所以如果 B 组成立，未打补丁宿主上用户拿不到「Reload agent」提示。
  - 本轮跑 `node harness/rewind-notice-delivery-check.mjs`（exit 0，30/30）：在「截断失败」的撤回后，daemon 时间线里出现 **4 条**「撤回已生效」notification 行（输出：`…while the appended report row survives the same rewind — notification | notification | notification | notification | plugin(…)`），说明 canary 会经宿主 provider history 重放进时间线。
  - 【跨 lane】`plugin-rewind-notice` 的 **RN-08** 从宿主 `PluginAgentSession.history.push` + `forceHydrateTimelineFromProvider` 机制出发，明确判定「实测修正」结论会误导，stock 宿主能显示、补丁宿主被截才是设计；`plugin-provider` 的 **PP-02/PP-03** 则采信「实测修正」，要求 docs lane 在 AGENTS 补限定。两 lane 结论相反。
- **证据等级**：【文档对照】【实测（离线 harness）】【跨 lane 佐证】
- **摘要**：这是本轮最需要收口的文档矛盾。当前证据不足以支持任一方单独定稿（「实测修正」声称来自真机，但本机宿主是**已打补丁**版；未打补丁宿主从未真机复验）。建议：① 先做一次「未打补丁宿主 + 真实 daemon」的 canary 可见性复验；② 在复验前不要按「实测修正」删改 canary，也不要继续把「Reload agent 提示一定出现」写成用户承诺；③ 复验后统一四处口径，并把「补丁/原版两种宿主、可见/不可见」的前提写在同一段里。

#### DC-02（P2）版本与发布线：README 混用两条线，更新日志收录了本仓库代码里不存在的 0.2.17 行为

- **位置**：`README.md:467-469`（版本策略）、`README.md:479`（0.2.17 条目）；`README.en.md:551-554`、`:566`；`paseo-plugin/package.json:3`；对照 `paseo-plugin/README.md:18-22`
- **文档原文**：「仓库里的版本号以 `paseo-plugin/package.json` 为**唯一来源**（本轮核对为 `0.2.16`）；npm 上最新发布是 `0.2.17`」；更新日志按 npm 发布顺序列出 0.2.17「统计行重新贴合页脚」。
- **实际**：
  - `paseo-plugin/package.json:3` = `0.2.16`；`npm view paseo-dsh version` = `0.2.17`，dist-tag `latest` = 0.2.17（数值本身一致）。
  - `npm view paseo-dsh@0.2.17 gitHead` = `f1830b6`（「Release 0.2.17: stats row measured against the footer」，在 `upstream/main` 上）；`npm view paseo-dsh@0.2.16 gitHead` = `90890d1`。**两者都不是本仓库 HEAD 的祖先**（`git merge-base --is-ancestor … HEAD` 均 false）。
  - 本仓库 HEAD 的代码**不含 0.2.17 的页脚测量**：`paseo-plugin/client/stream-stats.tsx` 141 行，只有固定 `marginTop: 2`；`grep -rn 'footer|tuck|measure' paseo-plugin/client` 无命中。
  - `upstream/main` 的树没有 `dsh-bridge/lib/revert.js`、没有 `local-patches/`、`client/` 只有 `stream-stats.tsx`（无 jobs-pill 等）；其 `dsh-process.ts` 头注释仍写 "A process owns exactly one agent session"。而本仓库 README 描述的是共享进程 + 撤回 + jobs 等 fork 特性，并把「一行安装」指向 `npm:paseo-dsh`。
- **证据等级**：【实测（npm registry + git ancestry）】【源码对照】
- **摘要**：三条版本信息单独看都对，但文档没有说明「npm 上的 0.2.16/0.2.17 是上游发布线，本仓库 HEAD 是含未发布 fork 特性的另一条线」；读者会以为 `npm:paseo-dsh` 装到的就是本仓库代码。另外本仓库版本号 0.2.16 与已发布的 npm 0.2.16 内容不同，若按 README「唯一来源」直接发布会被 registry 拒绝（版本已存在）。建议在「版本策略」里写清两条线、本仓库下一个可用版本号（≥0.2.18）、以及「npm 包不含撤回/共享进程/jobs，要这些能力需从本仓库源码装」；0.2.17 更新日志条目要么标成上游发布、要么删除。

#### DC-03（P2）`paseo-plugin/OVERVIEW.md` 的 jobs 语义仍写「空闲显示总数」，与 live-only 实现和 README 相反

- **位置**：`paseo-plugin/OVERVIEW.md:7`；对照 `paseo-plugin/client/jobs-polling.ts:141-150`、`paseo-plugin/client/jobs-pill.tsx:536-537`、`README.md:26`、`README.en.md:29`、`paseo-plugin/README.md:52,123`
- **文档原文**：「A background-jobs pill reports DSH jobs (**live count while running, total when idle**)」
- **实际**：pill 只在 `live > 0` 时可见，无 idle 总数：`jobs-pill.tsx:536-537` 注释写 "There is no idle total: the pill hides when nothing is live"；`jobs-polling.ts:141-150` 的 presentation 规则同。README 中英与包 README 已改为「只在有运行中/停止中任务时显示，全部结束即隐藏」。该行是 `c962e7d` 按旧语义写入、`e7472be` 回退代码时漏改（`fix-verify-plugin` 的 N1 也指出了同一处）。
- **证据等级**：【文档对照】【源码对照】【跨 lane 佐证】
- **摘要**：OVERVIEW 是 paseo.sh 插件页/包描述的用户可见文案（0.2.10 changelog 明确其用途），现在承诺了一个被产品决定移除的行为。改为 live-only 表述即可；同时检查 `paseo-plugin.json:3` / `package.json:4` 的 description（见 DC-12）。

### P3 发现

#### DC-04（P3）REWIND 的「响亮兜底」承诺不成立：fallback 通知会被客户端 legacy 清理删掉

- **位置**：`docs/REWIND.md:240-241`（「并退回 provider notice 作为响亮兜底」）；对照 `paseo-plugin/server/provider.ts:1336-1343`、`paseo-plugin/index.client.tsx:214-218`、`paseo-plugin/client/rewind-notice-data.ts:58-60`、`paseo-plugin/shared/rewind-notice.ts:230-244`
- **文档原文**：「真拿不到句柄时报告会排队，等下一次捕获后补发（排队与补发都写日志），并退回 provider notice 作为**响亮兜底**。」
- **实际**：fallback 通知的 `message` 就是共享撤回文案表里的成功/失败句子；客户端 transformer 对**所有** `itemType: "notification"` 行调用 `isLegacyRewindNotice()`，命中即 `{ items: [] }` 删除。所以 fallback 即使落地也会被客户端删掉；无 `PASEO_AGENT_ID` 时该通知还在 run lock 内发出、会被宿主 staging 丢弃（FIELD-NOTES #78）。用户可见层为零，只有插件 stderr 日志。【跨 lane】`plugin-timeline` 的 **TL-01** 已实测同一路径。
- **证据等级**：【文档对照】【源码对照】【跨 lane 佐证】
- **摘要**：要么修 fallback（让它的文案不被 legacy 清理命中 / 走另一条通道），要么把文档改成「仅 stderr 可见、用户看不到报告」；不能继续写「响亮兜底」。

#### DC-05（P3）AGENTS.md 的 FIELD-NOTES 编号上限过时（77 vs 79）

- **位置**：`AGENTS.md:59`
- **文档原文**：「七十余条真实缺陷（编号到 **77**，含 `b`/`c` 补记与 DSH 升版教训…）」
- **实际**：`docs/FIELD-NOTES.md` 现有 `### 78.`（:2727）与 `### 79.`（:2753），由本轮 `aa72484` / `8091777` 新增；最大编号 79。AGENTS.md 自 `6e2c7a4` 后未再更新。
- **证据等级**：【文档对照】
- **摘要**：上一轮 D15 的「编号」部分回归。改为「编号到 79」或干脆写「编号以 FIELD-NOTES 当前文件为准」。

#### DC-06（P3）harness 清单登记缺口：84 个脚本中 24 个不在 `docs/HARNESS.md`

- **位置**：`docs/HARNESS.md:1-9`（自称「逐脚本清单/新增检查登记在此」）、`AGENTS.md:215-217`（「逐脚本的离线检查清单在 docs/HARNESS.md」「新增检查也登记到那里，不要加回本文件」）；差集对象 `harness/` 84 个 `.mjs|.cjs`
- **文档原文**：「逐脚本的离线检查清单（断言什么、动了哪里必跑）在 docs/HARNESS.md」「新增检查也登记到那里，不要加回本文件」。
- **实际**：HARNESS.md 显式引用 58 个脚本（全部存在、无死引用）；**24 个文件未被登记**——19 个只在 AGENTS.md 有一行命令（`revert-check`、`surface-check`、`file-snapshot-check`、`snapshot-lifecycle-check`、`file-mutation-gate-check`、`rewind-merge-check`、`rewind-e2e`/`rewind-merge-e2e`/`rewind-native-check`、`revert-shape-probe`、`replay-fidelity-probe`、`factory-ownership-order-check`、`catalog`/`probe`/`stream-probe`/`steer-check`/`mcp-injection-check`/`assistant-stream-check`/`image-check`；`plugin-check.cjs`、`route-test.mjs` 只按 basename 被提及、无条目），5 个 `p003-*` 两处都没有索引（`p003-approval-preflight.mjs`、`p003-bridge-check.mjs`、`p003-live-check.mjs`、`p003-live-support.mjs`、`p003-permission-check.cjs`；其中 `p003-timeline-check.cjs` 已登记，说明是漏登记而非有意排除）。【跨 lane】`verify-runner` §2 与 `harness-bridge` HB-09 给出同一差集与判定，并建议由本 lane 收口。
- **证据等级**：【实测（目录遍历差集）】【文档对照】
- **摘要**：二选一：① 把 24 个条目补进 HARNESS.md（撤回链 + p003 可离线复跑的两条优先）；② 在 HARNESS.md 顶部声明「撤回链以 AGENTS.md 为准」，并给 5 个 p003 脚本建条目。不要维持两套清单。

#### DC-07（P3）本轮新增的撤回提示检查与语义未进必跑清单/规则文件

- **位置**：`AGENTS.md:231-282`（撤回节）、`docs/REWIND.md:371-396`（验证命令清单）、`.github/workflows/sync-upstream.yml:60-108`（CI 门）；对照 `docs/HARNESS.md:21-43`
- **文档原文/实际**：
  - HARNESS.md 已有 `rewind-notice-check.cjs`（客户端半）与 `rewind-notice-delivery-check.mjs`（送达半）的完整条目（`:21-43`）；
  - 但 AGENTS.md「改到撤回时按顺序跑」的 15 条清单、REWIND.md 的验证清单、CI 离线门都没有这两个脚本；`grep -n 'rewind-notice' AGENTS.md docs/REWIND.md .github/workflows/sync-upstream.yml` 均无命中；
  - AGENTS.md「三条不能破的约束 + 第四条 canary」也没有收录本轮新不变量：**完成报告必须走 `timeline.append`、在 `agent.timeline.replacement` 之后落行、在 `request.completed` 之后**（不能退回 `session.notice`），以及 canary 与完成报告的分工（`docs/REWIND.md:210-268`、FIELD-NOTES #79）。AGENTS.md 是整份注入每个会话的规则文件，缺这段会让后续 agent 把报告改回 notice 或被 run lock 吞掉。
- **证据等级**：【文档对照】【源码对照（`provider.ts:1035-1055,1093-1102,1172-1188`）】
- **摘要**：把两个新检查加进 AGENTS 撤回顺序清单与 REWIND 验证清单（delivery-check 需要已装宿主，可不进 CI，但 HARNESS.md 已写明运行方式）；AGENTS.md 的「不能破的约束」补一条完成报告约束，或至少指到 FIELD-NOTES #79 / REWIND「完成提示」一节。

#### DC-08（P3）RENDER-PLAN 与 `tokens.ts` 的渲染现状/行号已漂移

- **位置**：`docs/RENDER-PLAN.md:105`、`:168-169`、`:260`；`paseo-plugin/client/tokens.ts:8-12`
- **文档原文 vs 实际**：
  - `RENDER-PLAN.md:105`：「locale：客户端接上 `DSH_PASEO_LANG`」→ 实际客户端读不到 daemon 环境（`client/locale.ts:5-34` 自述），靠服务端在 tool-call item 上注入 `metadata.locale`（`server/timeline.ts:1205`）+ `index.client.tsx:79` 切换；README 已按此改写（D07 修复）。
  - `RENDER-PLAN.md:168-169`（「仍未做」）：「终端输出仍是会折行的 `Text`……状态点 / 退出码 pill / 复制键也都还没做」→ 实际已实现 224px 纵向 `ScrollView` + `CopyControl`（`tool-call.tsx:952-985`、`tokens.ts:1322-1331`），本轮 `client-toolcall` lane 的 CT-02 也确认。
  - `RENDER-PLAN.md:260`：「红色判据只有 `message.isError === true` 一条（`server/timeline.ts:916`）」→ 实际在 `timeline.ts:1110`。
  - `tokens.ts:8-12`：「224px on the output region … deliberately not declared here, because no block applies them yet」→ 同文件 `:1322-1331` 已声明 `TERMINAL_OUTPUT_MAX_HEIGHT = 224` 并被 `tool-call.tsx` 使用，注释自相矛盾。
- **证据等级**：【文档对照】【源码对照】
- **摘要**：RENDER-PLAN 不在上一轮 p11-docs 的写入边界（`FULL-AUDIT-20261102.md` §10.1 自述），本轮仍未修。建议给 RENDER-PLAN 加历史/「Phase 4b 之后」状态说明，或把「仍未做」改成实际清单；tokens.ts 头部注释同步。

#### DC-09（P3）FIELD-NOTES「客户端没有 locale 来源（未修）」已过时

- **位置**：`docs/FIELD-NOTES.md:800-802`
- **文档原文**：「**已知缺口（未修）**：插件客户端没有 locale 来源，`tool-call-data.ts` 的工具名……和思考行的 `思考中…`/`已思考` 都是硬编码中文……要修得给客户端一条 locale 通道（RPC 或在渲染数据里带上）。」
- **实际**：服务端已在 tool-call item 上注入 `metadata.locale`（`paseo-plugin/server/timeline.ts:1205`），客户端 transformer 调 `setLocale(localeFromMetadata(item.metadata))`（`index.client.tsx:79`）；工具名/思考行文案走 `client/locale.ts` 的标签表，不再硬编码中文。README 已按「首个 tool-call 后才切换、已渲染行不重绘」描述当前边界。【跨 lane】`client-misc` 的 CM-11/CM-12 给出同一判断。
- **证据等级**：【文档对照】【源码对照】【跨 lane 佐证】
- **摘要**：把「未修」改成「已通过 metadata.locale 中继（首个 tool-call 前的行仍默认 zh-CN）」，或标注为历史段落。

#### DC-10（P3）FULL-AUDIT-20261102 §10.1 把 CJ-02 记为 fixed，但隐藏轮询已被 `e7472be` 恢复为 4s

- **位置**：`docs/FULL-AUDIT-20261102.md:261`（p6-jobs fixed 列表）、`:279`（暂缓段）；对照 `paseo-plugin/client/jobs-polling.ts:48-56,166-177`
- **文档原文**：「p6-jobs | CJ-01（…）、**CJ-02**、CJ-03、CJ-04」（fixed）
- **实际**：`e7472be` 把修复轮的 `HIDDEN_POLL_MS=15_000` 恢复成 4s（`jobs-polling.ts:48-56` 注释自述「the hidden probe must stay at the same rate」），只保留退避与抖动；CJ-02 的「隐藏时降频」子项被回退，§10.3 暂缓段只记了「settled 历史仍全量轮询」，没有记录这次取舍。【跨 lane】`client-jobs` 的 CJ-02/N2 同判。
- **证据等级**：【文档对照】【源码对照】【跨 lane 佐证】
- **摘要**：把 p6-jobs 的 CJ-02 改成「部分修复（退避/抖动保留；隐藏 4s 全速按用户 live-only 语义恢复）」，或在 §10.3 补一条取舍说明。

#### DC-11（P3）源码注释引用不存在的 harness 脚本

- **位置**：`dsh-bridge/lib/mcp-http.js:21`
- **文档原文**：「`harness/mcp-gateway-check.mjs` drives it against a local HTTP server without a DSH profile」
- **实际**：仓库没有 `harness/mcp-gateway-check.mjs`；对应检查是 `harness/mcp-http-check.mjs`（以及 `mcp-gateway-transport-check.mjs` / `mcp-gateway-guard-check.mjs` / `mcp-gateway-call-check.mjs`）。【跨 lane】`bridge-mcp` 的 BM-18 已报。
- **证据等级**：【实测（`ls` / 全仓 grep 仅此一处死引用）】【源码对照】
- **摘要**：改注释指向 `harness/mcp-http-check.mjs`；顺便全仓 grep 确认没有其它死引用（本轮只发现这一处）。

#### DC-12（P3）能力清单缺撤回（含 files-only）与图片输出方向；清单 description 滞后

- **位置**：`README.md:15-30`、`README.en.md:18-33`、`paseo-plugin/README.md:40-57`、`paseo-plugin/OVERVIEW.md:7`（能力清单均无撤回）；`README.md:21`、`README.en.md:24`、`paseo-plugin/README.md:44`（图片只写输入）；`paseo-plugin/paseo-plugin.json:3`、`paseo-plugin/package.json:4`（description 仍是旧能力集）
- **文档原文 vs 实际**：
  - 四份能力清单都没有「撤回」条目，但 README 有整节「不装 local-patches 时的行为」在讲撤回，`docs/REWIND.md` 是本仓库最重的子系统之一；本轮新增的 `session.revert.files`（只回文件）也不在任何用户可见清单里。
  - 图片输出（工具产出图片 → `hostPath` → `file://` markdown 行，`image-host-path.js` + `timeline.ts:117-151`）只有 `OVERVIEW.md:9` 写全；README/en/包 README 只写输入方向。
  - `paseo-plugin.json` 的 description 仍写「question cards, plan mode, thinking levels, steering, images, a slash menu, permissions and presets」；`package.json` description 同——都没有 jobs/goal-workflow/审批卡/systemPrompt（README 已加）与撤回。
- **证据等级**：【文档对照】【源码对照】
- **摘要**：给四份能力清单补「撤回（对话 + 文件；可只回文件）」一行，图片行补一句输出方向；清单 description 与 README 能力表对齐。若撤回能力因未发布而刻意不宣传，应在 README 说明「本仓库源码含撤回，npm 包不含」（与 DC-02 同一问题）。

#### DC-13（P3）历史/计划文档里的「现在时」状态声明过时

- **位置**：`docs/0.12-ADOPTION.md:8-9`；`docs/plantree/baseline/README.md:11,13`
- **文档原文 vs 实际**：
  - `0.12-ADOPTION.md:8-9`：「发布状态：npm 上最新仍是 `0.2.9`……仓库已 bump `0.2.10`，等本机实测确认后再发布」→ 实际 npm latest 0.2.17、仓库 package.json 0.2.16。文件头虽标「历史记录（已并入 main）」，但这两句是现在时发布状态。
  - `plantree/baseline/README.md:11,13`：「当前修复基线 `1a41aba`，DSH `0.2.0-rc.2`，Paseo `0.11.2`」「本次继续在 Fork 修复；已有 PR #1…」→ 实际 HEAD `0c82df5`、DSH `0.2.1-rc.5`、Paseo `0.14.0`。
- **证据等级**：【文档对照】【实测】
- **摘要**：给这两处加历史标记并把现在时改成过去时（或直接删掉状态句），否则会被下一轮当成当前基线引用。

#### DC-14（P3）`plantree/003-capability-gap/excluded.md` 的行号锚点已漂移

- **位置**：`docs/plantree/plans/003-capability-gap/excluded.md:13`、`:38`、`:68`
- **文档原文 vs 实际**：
  - `:13` 「`provider.ts:1245-1248` 注释已写明」→ 实际 `provider.ts:1240-1252` 是 `request.failed` 分支，不是 `toolPolicy` 注释。
  - `:38` 「`session.ts:665-680` 保留了 skill 名」→ 实际 `session.ts:665-690` 是 plan 模式对账代码（文件已 3,549 行）。
  - `:68` 「`session.ts:2246` 发 stream-stats 行」→ 实际 `#streamStats` 声明在 `session.ts:501`、消费在 `:2490` 附近。
- **证据等级**：【源码对照】
- **摘要**：按 `docs/PLAN-REWIND-NATIVE.md` 的做法给这份决策记录加「行号会漂移，引用前重新 grep」的头部说明，或改成符号名。

#### DC-15（P3）模板说 `supportsDeveloperRole: false` 「不需要也无害」，与 ADOPTION 相反

- **位置**：`templates/cordis.patch.yml:35-40`；对照 `docs/ADOPTION.md:177-180`、`README.md:143-147`
- **文档原文**：模板「The probe tells you whether you need this line; **it is harmless if you do not**」；ADOPTION「网关支持 `developer` 角色时**不要加**——加了会把系统提示降成 `system` 角色」。
- **实际**：该模板经 `bridge-assets.ts` 的 `PROFILE_PATCH_TEMPLATE_BASE64` 内嵌（实测与 `templates/cordis.patch.yml` 逐字节一致，3,292 字节），会在用户首次加载时写进 `~/.dsh/profiles/paseo/cordis.patch.yml`，所以这条注释是用户可见的。
- **证据等级**：【文档对照】【源码对照（bootstrap/`writeIfAbsent` + 模板内嵌）】
- **摘要**：把模板注释改成与 ADOPTION 一致（「只有网关拒绝 developer 角色时才加；不确定就用 probe」），或明确说明「加了只是把系统提示换成 system 角色，不是错误但通常没必要」。

#### DC-16（P3）README「profile 会随插件一起更新」不准确：profile 文件不会被覆盖

- **位置**：`README.md:120-124`、`README.en.md:136-142`；对照 `paseo-plugin/server/bootstrap.ts:210-235`
- **文档原文**：「更新只走 Paseo 这一条链路：`paseo plugin update`…然后重启 daemon，**profile 会随插件一起更新**。」
- **实际**：`ensurePaseoProfile()` 对 `package.json` / `cordis.yml` / `pnpm-workspace.yaml` 用 `writeIfAbsent`（已存在**绝不覆盖**），`cordis.patch.yml` 只在不存在时创建；每次加载**只重写内嵌桥**（`replaceBridge`）。README 同文 `:130-131` 也说「文件已存在时绝不覆盖」，两处口径不一。
- **证据等级**：【文档对照】【源码对照】
- **摘要**：改成「插件更新会重写 profile 里的内嵌桥；你已有的 profile 文件与模型路由不会被覆盖」。

#### DC-17（P3）REWIND 的 files-only 节没写「排队输入会被一并丢弃」

- **位置**：`docs/REWIND.md:153`；对照 `dsh-bridge/lib/server.js` 的 `settleAgentForRevert`（丢 `nextStep`/`nextTurn` 两条收件箱，`server.js:2033-2045`）与 `:2676` 调用点
- **文档原文**：「与 `both` 相同的部分：取消运行中的根回合（`settleAgentForRevert`）；…」（conversation 节 `:55-62` 解释了排队输入会被丢，但 files-only 节只写「取消回合」）
- **实际**：files-only 也走 `settleAgentForRevert`，排队中的 `nextStep`/`nextTurn` 会被丢弃；而 files-only 不动对话，用户可能不理解为什么排队消息没了。桥侧实测见【跨 lane】`bridge-server-rewind` 的 BSR-03。
- **证据等级**：【文档对照】【源码对照】【跨 lane 佐证】
- **摘要**：在 files-only 节补一句「与 both 一样会丢排队输入（当前实现）」；若 BSR-03 后续修成 files-only 不丢 `nextTurn`，同步改文档。

#### DC-18（P3）AGENTS.md「改之前先读」索引缺 FULL-AUDIT-20261031

- **位置**：`AGENTS.md:64-70`
- **文档原文**：「改之前先读」列出 `FULL-AUDIT-20261020`、`FULL-AUDIT-20261029`、`FULL-AUDIT-20261102`。
- **实际**：仓库还有 `docs/FULL-AUDIT-20261031.md`（152 行，3 个 P1 的成因与迁移教训），且 `FULL-AUDIT-20261102.md:4` 明确写「上一轮全量审查：FULL-AUDIT-20261031」。索引缺它会让维护者跳过上一轮 P1 的教训。
- **证据等级**：【文档对照】
- **摘要**：补一条索引（一句话说明它包含 3 个 P1 与迁移方向撤回的教训）。

## 4. 阴性结论（已核查、判定成立）

1. **进程模型**：`README.md:247,277-285`、`README.en.md:280,311-325`、`docs/ADOPTION.md:34-38,388-395`、`OVERVIEW.md:3`、`AGENTS.md:33` 均写「一个 provider 连接共享一个 `dsh` 子进程」；与 `provider.ts` 的 `DshConnection.#pooled` / `#poolClaims`（`:403,448,497`）一致。上一轮 D02 已修。
2. **图片输出**：`OVERVIEW.md:9` 与 `dsh-bridge/lib/image-host-path.js`、`paseo-plugin/server/timeline.ts:117-151` 一致（带 `hostPath` 的块发 `file://` markdown 行）；`harness/image-host-path-check.mjs` / `image-check.cjs` 存在。D01 已修。
3. **Node 最低版本**：README/en/包 README/OVERVIEW 统一为 Node ≥ 20.4；`AbortSignal.any` 用在 `approval.js:14`、`file-mutation-gate.js:172`、`mcp-http.js:158`，`Symbol.dispose` 用在 `session-projections.js:41`；`paseo-plugin/package.json` 无 `engines`（与文档「不声明」一致）。D06 已修。
4. **DSH 内部包数量**：README/en/包 README/OVERVIEW 写八个；`node harness/dsh-api-contract-check.mjs` 实测 `8 package(s) loaded, 0 failed`、`12/12 passed`。D05 已修。
5. **桥方法数**：`docs/ADOPTION.md:88-92` 写 24 个；`dsh-bridge/lib/server.js:3270-3325` 的 `handleRequest` 实测 24 个 `case`。D09 已修。
6. **canary 顺序约束**：`AGENTS.md:261-265` 与 `provider.ts:1093-1102` 一致（canary 在 `request.completed` 之前；`scope === "files"` 不发）；`harness/revert-check.mjs` 120/120（含源码位置断言）。DC-01 只涉及「可见性」结论，不涉及顺序约束。
7. **本轮新语义的实现细节**：`docs/REWIND.md:146-163`（files-only 不 append/flush/prune、journal 保留、幂等）、`:210-268`（完成报告走 `timeline.append`、`replacement` 之后落行、固定行 id、`noticeId` 胶囊、旧 notice 清理）与 `provider.ts` / `rewind-notice-append.ts` / `rewind-notice-data.ts` / `rewind-notice-live.ts` 逐条核对一致；`docs/HARNESS.md:21-43` 两个新检查条目与脚本行为一致（编译目录、`DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS`、断言点）。
8. **撤回能力位**：`docs/REWIND.md:16,311` 写三种 `session.revert.*`；`provider.ts:102-104` 实测声明三种。
9. **AGENTS.md 技术断言**：`GATEWAY_STDIO_SERVERS` 只含 `server_browser`（`dsh-process.ts:608`）、`mcpEntries()` 存在（`:935`）、手写 stdio 客户端三方法（`mcp-stdio.js:383/405/437`）、捕获句柄只用 `on` hook 且不注册 `before("agent.session.open")`（`index.server.ts:25-30,81`）、`catalog`/`probe` 仍读写真实 profile 而 `route-test`/`tools`/`stream-probe`/`rewind-e2e` 系列默认一次性 `DSH_HOME`（grep 核对）、`rewind-native-check` 必须 `--allow-real-daemon`、`host-contract-sim` 判据取 `truncateHistoryFrom`——全部成立。
10. **AGENTS.md 体积**：实测 **23,864 字节**（307 行）；与用户 `~/.dsh/AGENTS.md`（10,498 字节）合计 34,362 字节，低于 65,536 字节预算约 30.7 KB，**当前无挤掉用户指令的风险**（FIELD-NOTES #77 的口径）。
11. **`templates/cordis.patch.yml` 与内嵌副本**：从 `bridge-assets.ts` 解出的 `PROFILE_PATCH_TEMPLATE_BASE64` 与 `templates/cordis.patch.yml` 逐字节一致（3,292 字节）；`harness/bridge-assets-check.mjs` 2/2。
12. **HARNESS.md 死引用**：HARNESS.md 提及的 58 个 `harness/*` 脚本全部存在（0 死引用）。
13. **install.sh 行为**：`--check` 只读、`--profile` 与 `DSH_PASEO_PROFILE` 不一致时拒绝、已有模型配置不覆盖、动到的文件先备份——与 README `:204-231` 描述一致（`install.sh:13-28,85-104,209-225`）。
14. **历史文档冻结标记**：`IMPL-CONTRACT.md`、`ONE-PROCESS-MULTI-SESSION-PLAN.md`、`PLAN-REWIND-NATIVE.md`、`PROGRESS-REWIND-NATIVE.md`、`FULL-AUDIT-20261020.md`、`0.12-ADOPTION.md` 均带「历史文档/内容保持当时原样」类标记；`parked-sessions.ts` / `harness/parked-sessions-check.cjs` 确已不在仓库。
15. **npm 版本数值与日期**：npm `latest` = 0.2.17（2026-10-30T08:52Z），README 更新日志 0.2.15/0.2.16/0.2.17 的日期与 npm `time` 一致；`paseo-plugin/package-lock.json` 顶层版本 0.2.16 与 package.json 一致。

## 5. 未验证项（不是结论）

1. **未打补丁宿主上的 canary 可见性**：DC-01 的关键分歧。本轮只有离线 harness 证据（截断失败路径下 canary 行出现在时间线）与另一 lane 的机制推断；**没有**在「原版（未打补丁）宿主 + 真实 daemon」上复验。本机宿主是已打补丁版（`local-patches/apply-rewind-history-truncation.mjs --check` 输出 rewind+turnId 均在位）。
2. **npm 0.2.17 的实际行为**：未安装、未跑；「npm 包不含撤回/共享进程/jobs」由 `upstream/main` 的文件面与 `gitHead` 祖先关系推断，未在真实安装上逐项验证。
3. **Paseo 0.9.2–0.13 兼容性**：README 写 Paseo ≥ 0.9.2，但新代码路径（`timeline.append`、`agent.timeline.replacement`、`jobs.list` RPC、`rewind.notice.arm`）是否在旧宿主可用未验证；本机只有 0.14.0。
4. **DSH 0.2.1-rc.5 上的真实模型回合**：本轮未跑（耗 token）；README/OVERVIEW 的「实测通过的是 0.2.1-rc.2」是 2026-10-20 的记录，rc.5 上是否有真实回合验证未确认（契约检查 12/12 只证明 import 符号在）。
5. **macOS 桌面版签名 CLI 无法打补丁**：本机 Linux，未验证。
6. **FIELD-NOTES「已知限制」里 0.11.2 基线的三条**（子代理二次运行 running/子代理审批/归档只写 App 内存）：本机 Paseo 0.14.0 未复测，按历史基线保留。
7. **`local-patches` 部署副本新鲜度**：仓库 `local-patches/apply-rewind-history-truncation.mjs`（127,356 字节，11-02）与 `~/.paseo/local-patches/` 副本（122,078 字节，10-29）**不同**；本机宿主已按新脚本打过补丁（`--check` 全绿），但若靠 `ExecStartPre` 重打，跑的是旧副本。这属交付/运维问题，见跨 lane。
8. **REWIND 里宿主行为的断言**（`agent-manager.rewind()` 对 files 跳过 force-hydrate、`plugin-provider.js` 截断只在 `scope !== "files"`）：由 local-patches 注入体与脚本注释佐证（`apply-rewind-history-truncation.mjs:291-296`），未直接读宿主源码逐行复核。

## 6. 跨 lane 提示

1. **canary 可见性两 lane 结论相反，不要单边修文档**：`plugin-provider` PP-02/PP-03 采信 REWIND「实测修正」（canary 在 daemon 时间线不可见）；`plugin-rewind-notice` RN-08 判定「实测修正」会误导（stock 宿主经 provider history 重放，补丁宿主被截是设计）。我的离线实测（delivery-check 截断失败路径出现 4 条 canary 行）支持 RN-08 的方向。建议 Lead 安排一次「未打补丁宿主 + 真实 daemon」的真机复验，再决定 DC-01 的收口方向；复验前保留 AGENTS 的 canary 顺序约束（host-contract-sim 仍断言 provider 缓冲区行为）。
2. **`plugin-timeline` TL-01**：fallback 通知被 legacy transformer 删除 → DC-04 的「响亮兜底」文档承诺不成立；修代码或改文档需同步。
3. **`client-jobs` CJ-02/N2**：CJ-02 的「隐藏降频」已被 `e7472be` 回退 → DC-10（FULL-AUDIT §10.1 标注过宽）；另 OVERVIEW 的 "total when idle" 由 `fix-verify-plugin` N1 也点名 → DC-03。
4. **`verify-runner` §2 / `harness-bridge` HB-05、HB-09**：24 个 harness 脚本未登记、两个新撤回检查未进 AGENTS/CI 清单 → DC-06/DC-07 收口。
5. **`client-misc` CM-11/CM-12**：FIELD-NOTES:800-802 的 locale「未修」已过时 → DC-09。
6. **`client-toolcall`**：RENDER-PLAN「仍未做」与 `tokens.ts` 头部注释已过时（终端 224px + 复制已实现）→ DC-08。
7. **`bridge-mcp` BM-18**：`mcp-http.js:21` 引用不存在的 `harness/mcp-gateway-check.mjs` → DC-11。
8. **`bridge-server-rewind` BSR-01/BSR-03**：files-only 首条消息被拒是**代码 P2**（不应把它写成语义）；files-only 丢排队输入是现状，文档可补（DC-17）。BSR-01 修好后请同步 `docs/REWIND.md:324-329` 的「首条消息不支持撤回」表述（现在会被读成所有 scope）。
9. **`local-patches` lane**：`UPGRADE.md` 引用仓库外脚本、部署副本与仓库不一致，属交付/运维；文档侧我只在未验证项记录，不在本 lane 判定。
10. **`plugin-timeline` TL-02/TL-09**：撤回提示的 locale 只覆盖成功文案（`failureTitle` 未接表、canary 全中文）；若后续把 canary 定为用户可见主通道，`docs/REWIND.md:242-251` 的「两种 locale 表」表述需补上失败行与 canary 的 locale 边界。
11. **修复轮报告口径**：`docs/FULL-AUDIT-20261102.md` 是 11-02 的时点记录，但被后续轮次当「当前事实」引用；除 DC-10 外，建议在报告头加一句「§10.1 的 fixed 结论以 HEAD 复核为准，e7472be 之后有回退」。

---

**结论一句话：** 没有 P0/P1；P2 三条集中在「版本/发布线混用」「OVERVIEW jobs 语义未回改」「撤回提示文档三种口径」，P3 主要是清单登记与历史/计划文档的现在时陈述；文档主体（架构、进程模型、Node/DSH 要求、桥依赖、命令入口）与 HEAD 实现一致。
