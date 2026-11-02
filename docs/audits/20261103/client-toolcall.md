# 客户端工具行与样式层审查（client-toolcall）

- 审查对象：`main` HEAD `0c82df5`（工作区只有未跟踪的 `V1.txt`/`v1.txt` 与本轮审计目录，无产品代码改动）
- 范围（逐行全量）：`paseo-plugin/client/tool-call-data.ts`（1563）、`tool-call.tsx`（1039）、`tokens.ts`（1334）、`agent-message.ts`（44），共 3980 行
- 为核字段保真另读（只读）：`paseo-plugin/index.client.tsx`（renderer schema 与 transformer）、`paseo-plugin/server/timeline.ts`（failed item 的 `error` 构造）、Paseo 0.14 协议类型（`paseo-plugin/node_modules/@getpaseo/protocol/dist/agent-types.d.ts`、`agent-message.d.ts`）、已装 Paseo 宿主 bundle（`@getpaseo/cli/.../web-ui/.../index-*.js` 的 `projectPluginTimelineItems`）、DSH 0.2.1-rc.5 的 `dsh-client-ui-tool` bundle/CSS、`docs/FULL-AUDIT-20261102.md` §3.2/§10.1/§10.3、`docs/FIELD-NOTES.md` #27/#30/#31/#33/#46、`docs/RENDER-PLAN.md` §4、`docs/AGENTS.md` 硬性约束
- 环境：DSH 0.2.1-rc.5、Paseo 0.14.0、Node v22.23.1
- 只读纪律：未修改产品代码/文档/harness、未做 git 写操作、未起真实 daemon/模型、未写真实 `~/.dsh` profile、未装包；编译产物只落在 gitignored 的 `paseo-plugin/.dbg-clientaudit/`（收工删除）与 `/tmp`

## 1. 范围与方法

**基线关系（归属判定的依据）**：`git log 2f71225..HEAD -- <四个文件>` 只有 `6394809`（修复轮）一个提交；`agent-message.ts` 自基线零改动，`tokens.ts` +14、`tool-call-data.ts` +71、`tool-call.tsx` +87。因此本报告里凡落在 6394809 新增行上的问题标「新引入」，其余标「基线已有」。

**证据等级**：`【实测】` = 本机命令跑出（编译真实纯模块后的探针 / 现有 harness / GNU diff / 基准计时，均记 exit code 或输出片段）；`【源码推断】` = 读当前源码/协议类型/安装包源码；`【文档】` = 对照 docs 与 FIELD-NOTES 的既有结论。无真机、无真实 daemon，涉及 UI 行为的一律进 §5 未验证。

### 1.1 现有回归实跑（当前 HEAD）

| 命令（`paseo-plugin/.dbg-clientaudit`，编译自真实源码） | 结果 | exit |
|---|---|---|
| `npx tsc --noEmit`（paseo-plugin 全量） | 0 error | 0 |
| `node tool-call-check.cjs` | **365 passed, 0 failed**（基线 336，本轮新增 29 条 C1/CT-02 断言） | 0 |
| `node agent-message-check.cjs` | **111 passed, 0 failed** | 0 |
| `node style-check.cjs` | **254 passed, 0 failed**（基线 253） | 0 |

### 1.2 修复核查（6394809 的 C1 / CT-02）

方法：用 `git show 2f71225:<file>` 把修复前模块编译到 `/tmp/prefix-audit/out`，与当前 HEAD 模块跑同一组输入（`/tmp/probe-prefix-vs-postfix.cjs`，exit 0），形成「修前红 → 修后绿」。

| 条目 | 结论 | 修前（2f71225） | 修后（HEAD） | 链路证据 |
|---|---|---|---|---|
| **C1** 失败原因在 mapper 边界丢失 | **已修** | failed write/MCP 行 `error=undefined`；failed MCP 空输出 `hasDetail=false`（红图标、无原因、不可展开） | `error="AUDIT_ERROR_PERMISSION_DENIED"` / `"connect ECONNREFUSED"`；`hasDetail=true` | mapper 读 `item.error`（`tool-call-data.ts:1311-1315,1049-1053`）→ 返回合同新增 `error`（`:163-175`）→ renderer schema 声明（`index.client.tsx:138`）→ 宿主投影确实保留 `error`（已装 Paseo bundle：`{callId,name,status,error,detail,metadata}`）→ 渲染器头部红字 + 展开红块（`tool-call.tsx:821-823,846,938-942`）；harness 新增断言（`harness/tool-call-check.cjs:267-378,1650-1700`） |
| **CT-02** 终端输出 6000 硬截断 | **已修（terminal 部分）** | 7000 字符输出 → `body.length=6007`（尾部丢失） | `body.length=7000`，无截断标记；卡片为 224px 纵向滚动区 + 复制全量（`tool-call.tsx:963-982`，`tokens.ts:1319-1332`） | DSH `TerminalBlock` 的 `--dsl-terminal-output-max-height:224px`、`maxLines: Infinity`、copyText 均在安装包 bundle 中核对；`truncate()` 改为按 UTF-16 码元边界回退（`tool-call-data.ts:1064-1071`，探针复验无孤立代理） |
| CT-02 的**非终端**部分 | **未修（残留）** | MCP 7000 字符 → 6007 | 仍 6007 | 见 CT-01 |

结论：两条修复都真实落地且带可红回归，未发现修复引入的正常路径新回归。残留与新增边界见 §3。

## 2. 健康度评分

| 维度 | 分数（1-5） | 理由 |
|---|---|---|
| 正确性 | **4** | C1 与终端截断两个主要数据缺口已修；read/search/diff/web 映射与 DSH 逐字保真维持；剩余边界：未知状态/未知 detail 的降级方向、web 空态判据、legacy diff 文件头、hunk 合并差一 |
| 健壮性 | **3** | fail-safe 回退仍干净；但「不知道当成功」仍在（unknown status）、未知 detail 不交还宿主、失败行的 `error` 文本无上限且与 body 重复、generic 大正文无恢复路径 |
| 可维护性 | **3** | 注释极详尽，但本轮修复留下**头注释与实现矛盾**（tokens.ts:8-12 vs 1319-1332）；双文案表（`BLOCK_COPY` vs `locale.ts`）、无消费者的契约字段、只被测试读取的常量仍在 |
| 契约一致性 | **3** | `error` 契约已补全并与 schema 钉住；但协议 detail 里 `cwd/exitCode/filePaths/…` 仍被丢弃；`ToolCallFailedTimelineItem.error` 在协议里是 `unknown`，客户端只认 `{message}` |
| 性能 | **3** | 默认折叠/惰性渲染良好；但 diff 结构卡转换期每文件 LCS 跑两遍（实测 2 diffs ≈ 30ms/行，同步在 transformer 里）、generic 代码面无 `bodyScroll`、终端全量正文进入行数据后移动端成本未验证 |
| 安全 | **5** | 纯展示层：无 HTML 注入面、`Link` 只放行 `http(s)`、`stringifyValue` 兜住循环/BigInt、无凭据/写操作 |
| 测试覆盖 | **3** | 修复区新增 29 条断言且 schema↔合同逐键比对；但仍是「数据层 + 源码文本级」断言，渲染行为无测试，且 `unknown status → completed` 仍被断言成预期 |

**总体约 3.4/5**（上轮 3.3）。比上轮好的地方正是上轮最痛的两条（失败原因、终端丢数据）已修且带红绿证据；仍被压住的是「降级方向」「无恢复路径的截断」「移动端渲染成本」与文档/契约同步。

**是否有阻断性健康问题**：**无**。无 P0/P1；工具行在正常路径（read/search/diff/web/terminal/agent_message）可正常渲染、展开与复制。

## 3. 发现列表

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| CT-01 | **P2** | `tool-call-data.ts:785,1064-1071,1539-1544`；`tool-call.tsx:1019-1034`；`tokens.ts:1333-1334` | 非终端工具输出/内容 > 6000 字符：MCP `unknown`、无 `presentationMeta` 的 read/fetch/search、`plan`、`plain_text`、`sub_agent.log` | 【实测】探针：read/fetch/plan/plain_text/sub_agent 均 7000→6007 且带截断标记；MCP 7000→6007（修前修后一致）。【源码推断】generic 代码面（`tool-call.tsx:1019-1034`）无复制、无 `bodyScroll`，`CODE_MAX_HEIGHT=260` 无消费者 | 基线已有（CT-02 残留 + CT-10 未接线） | 终端之外的正文仍被硬截断且**没有恢复路径**：generic 卡既无复制也无纵向滚动。DSH 对应形态是 `CodeBlock`（copyLabel + `.bodyScroll{max-height:260px}`）或 `ioCard`（`.ioSection{max-height:150px}` 两段滚动），安装包 CSS 已核对。用户看得到「…（已截断）」却拿不到全文 |
| CT-02 | P3 | `tool-call-data.ts:1311-1315`；`tool-call.tsx:846,938-942` | 失败的**非终端**工具输出 > 6000：body 被截断后 `body.includes(error)` 为 false，于是 errorBlock 与卡片正文同时渲染 | 【实测】failed MCP：`error.length=100000`、`body.length=6007`、`errorBlockWouldRender=true`；【源码推断】`error` 未经任何上限直接进 `<Text selectable>` | **新引入**（6394809） | 同一段输出在展开块里出现两次（红色全文 + 卡片内截断版）；且 `error` 文本无上限、无滚动/复制，超大失败输出（MB 级）会整段挂载。建议 errorBlock 也走上限/滚动，或对 `error` 与 `body` 做同源判定 |
| CT-03 | P3 | `tool-call-data.ts:1528-1532`；`harness/tool-call-check.cjs:264` | 协议出现新状态（`interrupted`/`blocked`/`preparing`）或脏数据 | 【实测】四个未知状态全部 → `completed`（探针）；【源码推断】回归把该行为断言成预期 | 基线已有 | 把「不知道」伪装成「成功」：图标 muted、`failed:false`。保守方向应是 `running` 或原样传字符串 |
| CT-04 | P3 | `tool-call-data.ts:1421-1425,1442-1461` | 协议出现未知 detail 变体且带 `input`/`output`（新旧 Paseo 版本错配） | 【实测】`{type:"image",input:{…},output:"rendered"}` → `{summary:"",headline:"",body:"",hasDetail:false}`；【源码推断】只有 `type==="unknown"` 才有 JSON 保底，且不 `return undefined` 交还宿主 | 基线已有 | 未知行变成不可展开的空白行，既不显示内容也不交还 Paseo 原生渲染 |
| CT-05 | P3 | `tool-call.tsx:644-645` | `web_search` 返回 answer 但无 citations（DSH 允许） | 【实测】mapper 保留 `answer="THE ANSWER"`、`sources=[]`；【源码推断】渲染判据只看 `sources.length===0` | 基线已有 | 答案下面印「未找到结果」，自相矛盾。DSH 判据是 `(answer 为空) && sources 为空` |
| CT-06 | P3 | `tool-call-data.ts:1337-1425`；协议 `agent-types.d.ts:157-245` | 任何 detail 带协议已定义的附加字段 | 【实测】shell 行不携带 `cwd/exitCode`，search 行不携带 `filePaths`（探针）；【源码推断】read `offset/limit`、fetch `code/codeText/bytes`、`sub_agent.actions`、`worktree_setup.commands`（含每步 status/exitCode）同样被丢弃 | 基线已有 | 用户看不到命令在哪个目录跑、退出码、抓取的 HTTP 码、子代理动作、worktree 步骤；失败且无输出的 bash 只剩服务端英文兜底 `tool failed`（`server/timeline.ts:1137-1139`），本可由 `exitCode` 补足 |
| CT-07 | P3 | `tool-call.tsx:1005-1011` | detail 带 `unifiedDiff` 且无 `presentationMeta`（旧日志/旧 DSH） | 【源码推断】`line.startsWith("+")`/`"-"` 分类，`--- a.ts`/`+++ b.ts` 被染成删除/新增行；同一行 `+A -R` 来自 `diffTotals` 却会跳过文件头 | 基线已有 | 统计与展开内容互相矛盾 |
| CT-08 | P3 | `tokens.ts:604-637` | write 行无 `presentationMeta` 且文件内容每行以 `+ - @ \` 空格 开头（纯 bullet Markdown、.patch、缩进文本） | 【实测】`diffShaped("- a\n- b\n+ c")===true`；write-no-meta 行 `diffStat={added:1,removed:2}`；【源码推断】注释承诺「raw contents 不会 fabricated」由外部条件兜着 | 基线已有 | 假 `+0 -N` 统计 + 整块按 diff 染色。`style-check:659` 仍把该行为固化 |
| CT-09 | P3 | `tokens.ts:598-616`（判据在 `:608`） | 同一 hunk 内两处改动之间恰好隔 `2*context`（=6）行未变 | 【实测】构造两处改动隔 6 行：GNU `diff -U3` 输出 1 个 `@@ -2,14 +2,14 @@`，本实现 2 个 hunk（`@@ -2,7` + `@@ -9,7`） | 基线已有 | 合并判据差一：应 `index - previous - 1 <= 2*context` |
| CT-10 | P3 | `tool-call-data.ts:1492-1494,1064-1071` | shell 命令（含长 heredoc 脚本）> 6000 字符 | 【实测】命令 7000 字符 → `headline.length=6007` 且带「…（已截断）」；同行的 `body` 已全量（7000） | 基线已有（修复后不对称） | 终端正文不再丢数据，但命令 banner 仍截断并混入本地化标记；DSH 命令区不截断。长命令尾部（往往是脚本主体）不可见 |
| CT-11 | P3 | `tool-call.tsx:974-982`；`docs/FIELD-NOTES.md:835,842`；`docs/FULL-AUDIT-20261102.md:279` | 移动端/Web 上展开含长输出的终端卡 | 【文档】FIELD-NOTES #30 记录同类「展开块里加内层滚动会吞掉点击、导致关不掉」；【源码推断】新的纵向 `ScrollView` 位于行 `Pressable` 内、`Text selectable`；全量 body（可达 MB 级）作为单个 `Text` 挂载，此前被 6000 上限兜住 | **新引入**（6394809）+ 未验证 | 交互（点输出区收起是否失效、嵌套纵向滚动谁先吃手势、长按选择与点击冲突）与移动端首帧/内存成本都未在真机验证；上轮 §10.3 明确把「terminal 全量正文的移动端渲染性能」列为暂缓项，本轮修复让它变成默认路径 |
| CT-12 | P3 | `tool-call-data.ts:677-702,713-752`；`tool-call.tsx:593,838` | 每个 edit/write 行（无论是否展开）在 transformer 里构建结构卡；展开后每次渲染重建复制文本与统计 | 【实测】同一 diff：单次 `diffOps+diffHunks` 8.63ms，`toolCallData` 1 diff 15.21ms（≈1.76×）、2 diffs 30.17ms（≈3.5×）——`diffPairRows` 与 `diffPairBody` 各自跑一遍 LCS；【源码推断】`data.rows.map(diffRowText).join("\n")`、`diffStat(data)` 在 render 中同步重算 | 基线已有 | 多文件编辑行把转换成本翻倍并压在 JS 线程；大 diff 展开时复制文本/统计每帧重建 |
| CT-13 | P3 | `tool-call-data.ts:125-208`；`tool-call.tsx` 全文无 `data.name/data.code/data.bodyLabel` 消费；`locale.ts:56-58` | 契约维护 | 【源码推断】`failed` 与 `status==="failed"` 重复（本轮 `failed` 只被冗余读取）；`code/bodyLabel/name` 无消费者；`BLOCK_COPY`（tool-call-data.ts:244-289）与 `locale.ts` 双文案表 | 基线已有（`failed` 部分改善） | schema 仍要求这些字段，任何改动都要同步两份；双文案表存在漂移风险 |
| CT-14 | P3 | `tool-call.tsx:407,470-476` | 空 read（0 行）/空 search（无结果） | 【实测】空 read `read.text=""`、空 search `search.text=""`；【源码推断】两处仍无条件渲染 CopyControl | 基线已有 | 点了复制空字符串；DSH 在空态不显示复制控件 |
| CT-15 | P3 | `tool-call.tsx:134-147,856-862` | 无障碍与卸载 | 【源码推断】`Pressable` 只有 `accessibilityRole/label`，无 `accessibilityState={{expanded}}`；`useCopy` 的 1s `setTimeout` 无清理（全文件无 `clearTimeout`） | 基线已有 | 屏幕阅读器不知道行是否展开；卸载后仍有一次 setState |
| CT-16 | P3 | `tool-call-data.ts:722-726`；`tool-call.tsx:582-583` | `write` 创建空文件（`content:""`、`diffs:[]`、`operation:"create"`） | 【实测】行 `{headline:"",body:"",hasDetail:false,diffBlock:null,summary:"/empty.txt"}` | 基线已有 | 只显示「写入 · /path」，既无「新建」状态也不可展开 |
| CT-17 | P3 | `tokens.ts:500-522,536-555` | 宿主主题用 8 位 hex（`#RRGGBBAA`）或 `oklch()`/CSS 变量 | 【实测】`isLightSurface("#ffffffff")===false`（浅色被判深色 → 12% wash）；`withAlpha("#ffffff80",.08)` 正常；非 hex/rgb 直接 `transparent` | 基线已有 | 浅色主题 diff 底纹偏重或消失；`withAlpha` 与 `isLightSurface` 支持的格式不一致 |
| CT-18 | P3 | `tokens.ts:8-12` vs `:1319-1332` | 阅读模块头注释 | 【源码推断】头注释仍写「两个终端 cap 刻意不声明、因为没有 block 应用它们、缺口记在 RENDER-PLAN §4」；而 224px 已声明并在 `tool-call.tsx:723` 接线。另：注释称 DSH 的 150px 是 command banner 上限，安装包 CSS 里 150px 实为 `.ioSection`（ioCard 详情区） | **新引入**（修复轮未同步头注释） | 注释强于/弱于实现都会误导后续修改；建议同步头注释与 RENDER-PLAN §4 |
| CT-19 | P3 | `tool-call-data.ts:1049-1053`；协议 `agent-types.d.ts:279-280` | 另一个 producer/旧 daemon 的 `error` 不是 `{message:string}`（协议类型是 `unknown`） | 【源码推断】只读 `value.message`；字符串、`{error:{…}}` 等形状一律得 `""`（harness 把「不可读形状 → 无原因」固化为预期） | **新引入**（6394809） | 失败行退回「红图标无原因」，且不响亮；可考虑对 `typeof error === "string"` 兜底或至少保留可见提示 |
| CT-20 | P3 | `harness/tool-call-check.cjs:264,392-407,1644,1671-1696`；`harness/style-check.cjs:768-773` | 测试判据 | 【实测】三脚本全绿的同时 CT-03 成立；【源码推断】新增的是数据层断言 + 渲染器**源码文本级**接线断言（不执行组件）；`CODE_MAX_HEIGHT` 仍只断言常量值 | 基线已有（修复区明显改善） | 「全绿」仍不能证明渲染行为；unknown status 的固化断言应在改降级方向时同步改 |

### 关键发现详述

**CT-01（P2）非终端正文的截断与无恢复路径。** 本轮修复把 terminal 从 `truncate()` 里豁免（`tool-call-data.ts:1539-1544`），但注释自己写明「其余 block 仍渲染进没有滚动区的代码面，所以保留上限」。问题在于那个「代码面」也没有复制：`tool-call.tsx:1019-1034` 只画 `headline`/`body` 两个 `Text`。实测 read（无 meta）/fetch（无 meta）/plan/plain_text/sub_agent 的 7000 字符正文全部 → 6007 且带「…（已截断）」；MCP `unknown` 同样。DSH 的对应形态是 `CodeBlock`（带 copyLabel/copiedLabel + `.bodyScroll{max-height:260px}`）或 `ioCard` 的两段 `.ioSection{max-height:150px}`（安装包 `dsh-client-ui-tool/lib/client.js` 与 CSS 已核对）。因此这是「同一类数据丢失，只修了最常见的 terminal 一半」。建议与 `CODE_MAX_HEIGHT` 的接线一起做：给 generic 代码面接 `CODE_MAX_HEIGHT` + 复制，再取消 `truncate()` 对 generic 的适用（或至少把完整文本交给复制控件）。

**CT-02（P3，新引入）失败行的 error 文本没有上限且会与正文重复。** `errorBlock = data.error !== "" && !data.body.includes(data.error)`（`tool-call.tsx:846`）本意是避免 shell 行把错误输出打两遍，但非终端行的 `body` 已被截到 6000，`includes` 必然 false，于是展开块先渲染一整段红色 `error`、再渲染截断后的同一段正文。实测 100000 字符的失败输出 → `error.length=100000` 全部进 `<Text selectable>`。建议：errorBlock 也走与 body 相同的上限/滚动，或让数据层给出「error 是否已包含在 body 中」的判定而不是在渲染层用 `includes`。

**CT-11（P3，新引入）终端内层滚动与全量正文的移动端代价。** 修复方向本身与 DSH 一致（224px 滚动 + 全量 copyText），但本仓库自己的 FIELD-NOTES #30 记过「展开块里加内层 `ScrollView` 会吞掉点击、导致关不掉」，而工具行整体仍包在 `Pressable` 里；`Text selectable` 与滚动手势/点击的冲突也未验证。另一方面，body 不再截断意味着一个数 MB 的构建日志会作为**单个 `Text`** 挂载，并常驻在插件行数据里（此前最多 6007 字符）。这两点都必须真机确认；若成立，最小修法是给 `Text` 分片/虚拟化或保留「显示截断 + 复制全量」的组合。

## 4. 阴性结论

- **C1 修复链路完整**：宿主投影保留 `error`（已装 Paseo bundle 源码）、mapper 读取、返回合同、renderer schema（`index.client.tsx:138`）、渲染器读取五段齐全；成功行 `error=""`、脏数据上的 error 被忽略、`detail.error` 不被当载体，harness 均有会红断言。
- **CT-02 修复的 terminal 部分与 DSH 语义一致**：224px 滚动、全量 copyText、`!running && !empty` 才显示复制键、`maxLines: Infinity` 都与安装包 bundle 对上；`truncate()` 的代理对回退实测不再留孤立代理。
- **agent-message.ts（44 行）**：本地声明与协议 `AgentMessageSchema` 逐字段一致（event 五值、sender `id` 必填 + `serverId`/`title` 可选、`text` 必填），注释说明的「不 import 0.11 协议包」理由成立；`agentMessageOf` 的防御性读取不会把坏 payload 变成假消息。
- **翻译边界**：`BLOCK_COPY` 与 `localeText()` 都按 `currentLocale()` 每次调用读取，locale relay（`index.client.tsx` 的 `setLocale(localeFromMetadata)`）位于 `toolCallData` 之前；本轮新增代码没有新增硬编码用户文案。
- **既有 fail-safe 未退化**：所有结构化 parser 失败仍回退纯文本（`parseSearch/parseRead/parseWeb/parseDiffBlock` 返回 null）；`hasDetail` 防止空代码面；`stringifyValue` 兜住循环/BigInt/undefined；`Link` 只放行 `http(s)`；`diffStat` 对 failed/canceled 返回 null（DSH 语义）。
- **schema↔合同**：`harness/tool-call-check.cjs:1644` 逐键比对仍全绿，`error` 已同时出现在两侧。
- **正常路径回归**：365+111+254 条断言全过、`tsc --noEmit` exit 0；未发现修复导致成功行/agent-message 行行为变化。

## 5. 未验证项

- **真机 UI/交互（iOS/Android）**：终端内层纵向 `ScrollView` 与行 `Pressable` 的点击/收起、嵌套纵向滚动手势归属、`selectable` 长按与滚动的冲突、224px 卡片的观感——本机无模拟器，全部未验证（CT-11）。
- **大输出成本**：MB 级终端输出作为单个 `Text` 的首帧/内存/滚动帧率，未做真机或 RN Web 性能测量；只做了数据层与代码路径推断。
- **C1 真实端到端**：未起真实 daemon + Paseo App 验证「宿主投影 → 插件 schema → 真机红字」全链路；宿主保留 `error` 的证据来自已装 0.14 bundle 源码，非运行实测。
- **主题颜色实际格式**：Paseo 默认/自定义主题是否出现 8 位 hex、`oklch()` 或 CSS 变量未知（CT-17 只在函数层实测）。
- **`theme.colors` 引用稳定性**：`buildStyles` 的 `useMemo([colors])` 是否因宿主每帧新建 theme 对象而失效，未做渲染计数。
- **DSH 命令 banner 的 150px 上限**：安装包中只定位到 `.ioSection{max-height:150px}`（ioCard），未定位到 terminal command 的独立上限；tokens.ts 头注释的 150px 归属因此标为「文档与安装包不一致」（CT-18），未断言 DSH 一定有该上限。
- **Paseo 其它版本**：`error` 透传与 `agentMessage` 投影只核了本机安装的 0.14.0；0.12/0.13/0.15 未验证。
- **`BODY_LIMIT` 对复制语义的影响**：generic 卡当前无复制控件，若后续加复制，`truncate()` 的本地化标记会进入复制文本——未定方案。

## 6. 跨 lane 提示

- **docs-consistency（task-22）**：`docs/RENDER-PLAN.md:163-170` 仍写「终端输出…复制键还没做」，与当前实现（224px 滚动 + 复制）矛盾；`tokens.ts:8-12` 也仍把 224px 记为「未做的缺口」。修复轮改了代码但没同步这两处文档/注释。
- **plugin-timeline（task-9）**：`server/timeline.ts:1137-1139` 的 failed 兜底文案 `"tool failed"` 是硬编码英文，客户端原样显示在中文界面的行头；建议服务端侧补 locale 或让客户端对兜底串做本地化（CT-06/CT-19 的相关面）。
- **harness-plugin（task-17）**：`harness/tool-call-check.cjs:264` 仍断言 `unknown status → completed`；渲染器接线是源码文本级断言（`mentions`/`elementsWithAttributes`），不是行为测试。若本轮修 CT-03，需同步改这条断言。
- **client-jobs / client-misc 分工提醒**：任务书里「token 统计与上下文占用渲染」不在本 lane 的 `tokens.ts`（它是**样式 token 表**）；上下文占用/流式统计在 `paseo-plugin/client/stream-stats.tsx`，已由 client-misc（task-13）覆盖。本报告不重复审查该文件。
- **修复轮 p7-client 本身**：C1/CT-02 的代码修复质量可接受（链路完整、有红绿回归）；但新引入的 CT-02/CT-11/CT-18/CT-19 都是「修复的边界没算完」，建议下一次修复轮把「generic 代码面恢复路径」「error 上限」「注释/文档同步」一起收口，而不是只修被点名的那一半。
