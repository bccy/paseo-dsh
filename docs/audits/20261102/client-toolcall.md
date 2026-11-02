# 客户端工具行与样式层审查（client-toolcall）

- 审查对象：`main` HEAD `2f71225`（工作区干净，唯一未跟踪项是本轮审查目录 `docs/audits/20261102/`）
- 范围（逐行全量）：`paseo-plugin/client/tool-call-data.ts`（1500）、`tool-call.tsx`（974）、`tokens.ts`（1320）、`agent-message.ts`（44），共 3838 行；为核字段保真另读了 `index.client.tsx`、`client/locale.ts`、`client/newest.ts`、`client/text-shimmer.tsx`、服务端 `paseo-plugin/server/timeline.ts`（tool detail / presentationMeta / failed error 的构造），以及宿主 Paseo 0.14.0 协议的 `ToolCallTimelineItem`/`ToolCallDetail` 和 DSH 0.2.1-rc.5 的 `dsh-client-ui-tool` 模型 + web bundle 里 `ReadBlock`/`SearchBlock`/`WebBlock`/`TerminalBlock`/`DiffBlock` 的真实实现。
- 方法：先确认基线关系——**这四个文件自 `9298c28` 以来 `git diff` 为空（零改动）**，因此所有发现都是「基线已有」；再逐行读审 + 在 `/tmp` 下用真实 `tsc` 编译这四个纯模块跑最小复现（不做任何 tracked 文件写入），最后与 DSH 安装包源码逐函数对照。
- 证据分级：**实测** = 本机命令跑出（编译后的真实模块 / GNU `diff` 对照 / 现有 harness）；**静态** = 读源码与宿主/DSH 安装包；**未验证** = 明确未执行（无真机、无 daemon、未截图）。
- 现有回归实跑：`harness/tool-call-check.cjs` **336/336**、`harness/agent-message-check.cjs` **111/111**、`harness/style-check.cjs` **253/253**，均 exit 0；`paseo-plugin` 的 `tsc --noEmit` exit 0。编译产物与临时脚本只落在 `/tmp` 与 gitignored 的 `paseo-plugin/.dbg-clientaudit`（已删）。
- 环境：DSH 0.2.1-rc.5、Paseo 0.14.0、Node 22.23.1。

## 1. 结论摘要

**无 P0/P1，无阻断性健康问题。** 工具行映射的整体保真度很高：read/search 的复制文本、`shown/total` 计数、head+tail 折叠、被折叠掉的 group header 回填到 tail，与 DSH 的实现**逐字一致**（见 §4）；diff 的 rows/copyText 也一致；未知 meta 一律 fail-safe 回退纯文本，不会画出空白卡。

但有两类问题值得优先处理：

1. **「失败要知道为什么失败」这一半没做。** 基线 C1（失败原因丢失）**未修复**，而且范围比基线写的大：服务端确实把 `{message}` 挂在 failed item 上，客户端 `toolCallData` 收着 `error` 参数但**从不读取**，返回合同、renderer schema、渲染器三处都没有错误位。实测 failed 的 edit/write/mcp 三例，错误信息全部丢失；mcp 失败行 body 为空 → 整行只剩一个红色图标，连「连接被拒绝」都看不到。现有回归只断言 `failed` 标志，所以全绿。
2. **终端输出被硬截断 6000 字符且没有任何恢复路径。** 没有纵向滚动、没有复制控件——DSH 的 TerminalBlock 是「全量数据 + 224px 滚动 + copyText」，我们是「丢数据 + 撑满时间线」。构建/测试日志、长 heredoc 输出都会被切掉尾部（往往正是失败摘要所在）。

另有 15 条 P3：未知 detail type 变成不可展开的空白行（且不交还宿主）、未知状态被降级成 `completed`、`web_search` 有 answer 无 sources 时错误显示「未找到结果」、协议里已有的 `cwd`/`exitCode` 等字段被丢弃、无 meta 时 legacy diff 把 `---`/`+++` 文件头染成增删行、hunk 合并边界与 GNU/DSH 差一行、`CODE_MAX_HEIGHT` 只有 harness 在读而渲染器从未接线，等。最需要警惕的是**测试把错误行为固化成预期**：`tool-call-check.cjs:256-257` 明确断言「unknown status falls back to completed」。

## 2. 发现清单

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| CT-01 | **P2** | `client/tool-call-data.ts:1231-1245`（收 `error?: unknown`）、`:1259`（`failed` 只看 `status`）、`:1467-1499`（返回合同无 error）；`index.client.tsx:150-188`（schema 无 error）；`client/tool-call.tsx:813-816`（只用 status 给图标上色，无错误区）；服务端 `server/timeline.ts:1136-1139` | 任何 DSH 工具 `isError:true`：write/edit 展开仍是计划内容/diff；read_image/MCP 等 output 为空时整行无任何失败文字；错误文本只在 `item.error.message`，界面从不读 | 实测（编译真实 mapper：edit/write/mcp 三例 `errorSurvives=false`；mcp 失败 `body=""`）+ 静态 | 基线已有：FULL-AUDIT-20261031 的 C1，**未修复**；四文件自 `9298c28` 零改动 |
| CT-02 | **P2** | `client/tool-call-data.ts:762`（`BODY_LIMIT=6000`）、`:1017-1019`（`truncate` 加「…（已截断）」）、`:1483`；`client/tool-call.tsx:900-919`（terminal 卡片无 ScrollView、无复制） | 任意 output > 6000 字符（构建/测试/长 heredoc 日志）：只显示前 6000 字符；无滚动、无复制，DSH 的 224px 滚动区与 copyText 都没做；截断点可落在代理对上（实测 `cut[5999]=0xD83D` 孤立高位代理 → 界面出现 `�`） | 实测（编译真实 mapper：7000 → 6007，尾部丢失）+ DSH 对照（bundle `uF` 的 `copyText`/`maxLines`/`--dsl-terminal-output-max-height:224px`） | 基线已有（`c18336c` 起，文档未记录过这个截断）；RENDER-PLAN §4 只记了「无横向滚动/退出码 pill/复制键」，未记丢数据 |
| CT-03 | P3 | `client/tool-call-data.ts:1365-1368`（default 分支只清空 primary/body）；对照 `:1386-1405`（`type==="unknown"` 才有 JSON 保底） | 协议出现未知 detail 变体（或旧/新 Paseo 版本错配）：即使 detail 里带 `input`/`output`，行也只显示 wire name，`hasDetail:false` 不可展开；既不显示也不返回 `undefined` 交还宿主原生渲染 | 实测（`{type:"image",input:{…},output:"rendered"}` → `{label:"future_tool",summary:"",headline:"",body:"",hasDetail:false}`）+ 静态（`index.client.tsx` 只对 `agent_message` 交还宿主） | 基线已有 |
| CT-04 | P3 | `client/tool-call-data.ts:1472-1476`；`harness/tool-call-check.cjs:256-257` | 协议新增状态（如 `interrupted`/`blocked`/`preparing`）或脏数据：一律显示为 `completed`，`failed:false`、图标 muted —— 把「不知道」伪装成「成功」 | 实测（mystery/interrupted/blocked/preparing 四值全 → completed）+ 静态（回归把这个行为断言成预期） | 基线已有；`tool-call-check` 在 `c18336c` 就固化了它 |
| CT-05 | P3 | `client/tool-call.tsx:638-640`（`sources.length===0` → `webNoResults`） | `web_search` 返回 answer 但没有 citations（DSH 的 web_search 允许只给摘要）：界面在答案下面印「未找到结果」，自相矛盾；DSH `xU` 的判据是 `(answer 为空) && sources.length===0` 才显示 noResults，answer 非空时渲染空 `<ol>` | 静态（DSH web bundle `function xU(...)` 的 `s` 判定）+ 实测（mapper 保留 `answer="THE ANSWER"`、`sources.len=0`） | 基线已有（Phase 4b 的 web 卡） |
| CT-06 | P3 | `client/tool-call-data.ts:1282-1289`（shell 只取 command/output）、`:1319-1329`（search 只取 query/content；fetch 只取 url/result）、`:1330-1347`（sub_agent/worktree_setup 只取 description/log）；协议 `agent-types.d.ts:188-211`、`:222-245` | 协议 detail 里有、Paseo 原生行会用到的字段被丢弃：`shell.cwd`、`shell.exitCode`（服务端 `timeline.ts:591-596` 已经在填 cwd，exitCode 条件性填）、`search.filePaths/webResults`、`fetch.code/codeText`、`read.offset/limit`、`sub_agent.actions`、`worktree_setup.commands`（含每条命令的 status/exitCode/log）。用户看不到命令在哪个目录跑、退出码、子代理动作、worktree 步骤 | 静态（协议 + 服务端字段构造）+ 实测（cwd/exitCode 不出现在任何输出字段） | 基线已有 |
| CT-07 | P3 | `client/tool-call.tsx:940-947`（`line.startsWith("-")` → del） | detail 提供 `unifiedDiff`（含 `---`/`+++` 文件头）且 `metadata.presentationMeta` 缺失：`--- a.ts` 被当删除行染红、`+++ b.ts` 被当新增行染绿；而同一行的 `+A -R` 统计（`tokens.ts:566-600`）却会跳过文件头 —— 统计与展开内容互相矛盾 | 静态（渲染分支 + `diffTotals` 的文件头规则） | 基线已有 |
| CT-08 | P3 | `client/tokens.ts:604-626`（注释承诺「write raw contents … yields null instead of a fabricated +0 -3」）、`:613-617`（实际 `diffShaped` 只按行首字符判断）；`client/tool-call-data.ts:1296-1302`（write 恒 `diff=true`）；`harness/style-check.cjs:658-661` | write 行没有 presentationMeta（旧日志/旧 DSH/其它 producer）且文件内容每非空行都以 `+ - @ \` 或空格开头（纯 bullet Markdown、纯 `.patch` 文件、纯缩进文本）：`diffStat` 显示假 `+0 -N`，展开走 legacy diff 分支把内容染成删除行。注释的保证实际由「生产路径总有 meta」+「失败态隐藏统计」两个外部条件兜着，函数本身并不成立；`style-check:658` 还把 `- a\n- b\n+ c === diffShaped` 固化成预期 | 实测（`diffShaped("+add\n-del\n@@ hunk\n\\ no newline")===true`、`diffStat` 给 `{added:1,removed:1}`）+ 静态 | 基线已有（`c18336c`） |
| CT-09 | P3 | `client/tool-call-data.ts:585-603`（合并判据 `index - previous <= 2*context`） | 同一个 DSH hunk 片段内两处改动之间恰好隔 6 行未变行：GNU `diff -U3`/DSH `structuredPatch(context:3)` 合并为 **1 个** hunk，我们拆成 **2 个**，行里多出一条 `@@` 头（我们刻意的 hunk 头在此更显眼）。判据差一：中间 context 行数 `k = index - previous - 1`，应 `k <= 2*context` | 实测（GNU `diff -U3` 输出 1 个 `@@ -7,14 @@`；我们的 `diffHunks` 输出 `@@ -7,7` + `@@ -14,7`）+ 静态（`diff` 包 `structuredPatch` 语义） | 基线已有 |
| CT-10 | P3 | `client/tokens.ts:1317-1320`（`TERMINAL_MAX_LINES`/`CODE_MAX_HEIGHT`）、`harness/style-check.cjs:767-768`；渲染器 `client/tool-call.tsx:591-603`、`:954-969` | 长 read/diff/代码块展开后没有纵向限高、没有内层滚动，全量渲染（CODE_MAX_HEIGHT=260 从未被渲染器读取，只有 style-check 在断言这个数）；同时终端也不折叠（TERMINAL_MAX_LINES 同理只被测试读）。上千行的 read/diff 展开＝几千个 `Text` 一次性挂载，首帧可能卡顿；DSH 用 `.bodyScroll{max-height:260px}`。注释说「a constant nothing reads is a promise the code does not keep」，这两个常量正好落在同一句话上 | 静态（`grep CODE_MAX_HEIGHT paseo-plugin/` 只有 tokens.ts 与 harness；渲染器无 maxHeight/纵向 ScrollView）+ 性能推断 | 基线已有；「无 bodyScroll 限高」在 RENDER-PLAN §4 只对 `run_code` 点过名 |
| CT-11 | P3 | `client/tool-call-data.ts:666-689`（`diffPairRows` 与 `diffPairBody` 各自跑一遍 `diffOps`+`diffHunks`）、`:1416-1434` | 每次 `toolCallData`（在 transformer 里、与用户是否展开无关）都会同步构建 search/read/diff 的结构卡；单文件 diff 的 LCS 被算两遍（rows 一遍、body 一遍）。多文件/大 hunk 的编辑行会把转换成本翻倍，且发生在渲染关键路径上 | 静态（调用点）+ 实测（同一 diff 的 rows/body 生成路径） | 基线已有 |
| CT-12 | P3 | `client/tool-call-data.ts:125-195`（`ToolCallData` 定义）；`client/tool-call.tsx` 全文 grep 无 `data.failed`/`data.bodyLabel`/`data.code`/`data.name`；`client/locale.ts:56-58` 自认「bodyLabel 是 contract field，行从不读」 | 契约面漂移：`failed` 与 `status==="failed"` 表达同一事实两遍且渲染器只读后者；`code` 注释自认“nothing branches on this any more”；`bodyLabel`/`name` 全无消费者。schema 仍要求它们，任何未来改动都得同步两份 | 静态（grep 消费面） | 基线已有 |
| CT-13 | P3 | `client/tool-call.tsx:465-471`（read 卡恒给 `text=data.text`）、`:402`（search 恒显示 CopyControl）；DSH `gF`/`zF` 的 `onCopy: r.length>0` / `!y && copyButton` | 空 read（0 行）/空 search（无结果）时仍显示「复制」，点了复制空字符串；DSH 在空态不显示复制控件 | 静态（渲染分支 + DSH 实现对照） | 基线已有 |
| CT-14 | P3 | `client/tool-call.tsx:821-827`（Pressable 只有 role+label）；`:129-142`（复制成功 1s `setTimeout` 无清理） | 无障碍：`accessibilityState={{expanded}}` 缺失，屏幕阅读器不知道行是否展开；`hasDetail:false` 的行仍是可聚焦 button，按下无任何动作。定时器方面与 DSH 的 `gF`（同样 1s 连 timer 不清理）同构，React 18 下不报警告，仅记录 | 静态（JSX 接线；DSH 对照） | 基线已有 |
| CT-15 | P3 | `client/tool-call-data.ts:709-713`（write 且 `diffs.length===0` 时要求 `detail.content!==""`，否则 `null`），`:1436-1438`、`:1493` | `write` 创建**空文件**（content=""，DSH 给 `diffs:[]` + `operation:"create"`）：`diffBlock=null`、`body=""`、`headline=""`、`hasDetail=false` → 行只显示「写入 · /path」，既无「新建」状态也不可展开；DSH 的 diff 卡会显示 New file 状态与新文件路径 | 实测（`{operation:"create",diffs:[]}` + `content:""` → 全空） | 基线已有 |
| CT-16 | P3 | `client/tokens.ts:536-555`（`isLightSurface` 只认 3/6 位 hex）、`:500-522`（`withAlpha` 对非 hex/rgb 返回 `transparent`）、`:47-52`（`ROW_HEIGHT`/`ROW_FONT_SIZE` 固定 px）；`client/tool-call.tsx:796-799`（`layout.compact` 只改图标尺寸） | 若宿主主题用 8 位 hex（`#RRGGBBAA`）或 `oklch()`/CSS 变量：浅色主题会被判成深色 → diff 底纹 12% 而非 8%；无法解析的颜色直接没有底纹。行高/字号写死 24/13，DSH 用 `--dsh-content-font-delta` 跟随字体缩放；compact 模式只缩图标，行高不变 | 实测（`isLightSurface("#ffffffff")===false`；`withAlpha` 正常降 alpha）+ 未验证（宿主主题实际取值格式、真机大字体） | 基线已有 |
| CT-17 | P3 | `harness/tool-call-check.cjs:250-258`、`:263-266`、`harness/style-check.cjs:655-690`、`:767-768`；`client/tool-call.tsx` 全文无行为测试 | 测试覆盖：① C1 的错误保真无任何断言（只有 `failed` 标志）；② unknown status 被断言成 completed（把错误行为固化）；③ 渲染层（legacy diff 行分类、web 空态、复制控件、终端卡、展开分支）几乎不测，`style-check` 明说组件刻意不断言；④ `CODE_MAX_HEIGHT` 只断言常量值 → 常量与接线脱节也是绿的；⑤ 无 meta 的 legacy 路径只有「body 原样」级断言 | 实测（三个回归全绿同时 CT-01/04 成立）+ 静态 | 基线已有 |

**未发现**：映射函数抛错路径（`stringifyValue` 兜住循环/BigInt/undefined、`str()` 对任何非字符串返回 ""、`metaOf`/`isRecord` 拒绝数组）；任何会画空白卡的 fail-safe 缺口（所有结构化 parser 失败都回退纯文本，且 `hasDetail` 防止空代码面）；`ToolCallData` 与 renderer schema 的 key 集漂移（`tool-call-check` 钉住了）；copy 文本与 DSH 的逐字一致性；`search` 的 shown/total/折叠/尾行 header 回填逻辑；`edit` 的多行 `-`/`+` 前缀、`@@` 头省略 `,1`、`contentLines` 的尾换行规则；`linkLabel` 的去凭据/去端口；Paseo mark 与逐工具图标映射；`agent_message` 的语义行与宿主交还 guard。

## 3. 关键发现详述

### CT-01（P2）失败原因在 mapper 边界丢失（基线 C1，未修复）

证据链（全部本机可复现）：

1. 服务端确实携带错误：`server/timeline.ts:1134-1139` 在 `message.isError === true` 时把 item 写成 `status:"failed"`、`error:{message: output || "tool failed"}`。
2. 客户端签名接收但不读：`tool-call-data.ts:1231-1245` 声明 `error?: unknown`，`:1259` 只做 `const failed = item.status === "failed"`；返回合同（`:1467-1499`）没有错误字段。
3. 渲染器只有图标：`tool-call.tsx:816` 用 `rowIconColor(colors, data.status, data.diff)` 把图标染红，展开分支（`:893-971`）没有任何错误区域；schema（`index.client.tsx:150-188`）也没有错误位，即使 mapper 加了字段也会被宿主 strip。
4. 最小复现（编译真实模块）：
   - failed edit：`error` 不在返回对象，`body` 仍是 `- x\n+ y`（计划 diff）。
   - failed write：`body` 仍是 `"SECRET"`（计划写入内容）。
   - failed MCP（`output:""`）：`body:""` → 行上没有任何失败文字。
   对比 DSH：`tool-call-model.d.ts:59-60` 有 `errorSummary: string | null`（错误行显示结果首行），`resultText` 对空结果还回退结构化错误；我们的行完全没有这个概念。

影响比基线写的更大：基线只点了 write/edit；实际上**所有 output 为空的失败工具**（MCP、read_image、其它 provider-native 工具）都变成「红图标 + 无原因」。修复需同时改 mapper 合同、schema、渲染器三处，并加一条「错误只在顶层 tool_call 上、成功路径无错误块」的会红回归。

### CT-02（P2）终端输出硬截断 6000，DSH 是滚动 + 复制

`tool-call-data.ts:762` 的 `BODY_LIMIT = 6000` 从第一版渲染实现（`c18336c`）就在，`truncate()`（`:1017-1019`）在尾部拼 `\n…（已截断）`，terminal 卡片（`tool-call.tsx:900-919`）只有一个 `Text`。对照 DSH `TerminalBlock`（bundle `uF`）：`copyText`、`maxLines: 16`、`--dsl-terminal-output-max-height: 224px` + `overflow-y:auto`、exitCode/signal 胶囊、runStateDot —— 我们是「全量数据被切掉 + 无恢复入口」。

两个具体后果：

- 用户拿不到截断后的内容（没有复制、没有滚动、没有「查看详情」）；解析构建/测试输出时，失败摘要常在尾部，正好被切掉。
- 截断点不感知 UTF-16：实测 `"a"*5999 + "😀"` 的 `body[5999]` 是孤立高位代理 `0xD83D`，真机上显示 `�`。

RENDER-PLAN §4 已经记录「终端输出仍是会折行的 Text、状态点/退出码/复制键都没做」，但**没有记录 6000 字符丢数据**。建议与 CT-10 一起改：terminal 卡换成带 `maxHeight` 的纵向 `ScrollView`（`CODE_MAX_HEIGHT` 已经存在），补一个复制控件；即使保留截断，也应该截在完整码点边界并把完整文本交给复制。

### CT-03/CT-04（P3）未知降级的两个方向都选错了

- **未知 detail type**（CT-03）：`tool-call-data.ts` 的 switch 只认协议当前 11 个变体，default（`:1365-1368`）把 primary/body 清空；而「带 input/output 的保底」只在 `type === "unknown"` 分支（`:1386-1405`）里。实测 `{type:"image", input:{path:…}, output:"rendered"}` → `hasDetail:false`、不可展开的空白行。它既不显示内容，也没有像 `agent_message` 那样 `return undefined` 交还宿主原生渲染（`index.client.tsx:69-115`）。协议 0.14→0.15 的 diff 只把 `sub_agent.log` 变可选、没有新增变体，所以当前不可达，但这是 Paseo 升级时的静默降级面。
- **未知 status**（CT-04）：`tool-call-data.ts:1472-1476` 把四值之外的任何 status 归成 `completed`。按本仓库「失败要响亮、不知道不能当成功」的原则，兜底应选保守方向（`running`，或原样传字符串让 renderer 决定），至少不能伪装成成功。现在 `tool-call-check.cjs:256-257` 把它固化成预期，改的时候要同步改断言。

### CT-05（P3）web_search 空态判据与 DSH 相反

我们的渲染器（`tool-call.tsx:638-640`）只要 `sources.length===0` 就显示「未找到结果」，而 DSH（bundle `xU`）的判据是 `(answer===undefined || answer==="") && sources.length===0`。触发：`web_search` 只返回 answer、没有 citations —— 界面会在答案下面印「未找到结果」。修复只需把判据改成同样的合取，并给「answer 非空、sources 空」补一条断言。

### CT-07/CT-08/CT-09（P3）diff 保真的三个边界

- **legacy diff 文件头**（CT-07）：`tool-call.tsx:940-947` 用 `line.startsWith("+")`/`"-"` 分类，`--- a.ts`/`+++ b.ts` 会分别变成 del/add 行染红绿；而同一行的 `+A -R` 来自 `tokens.ts:566-600` 的 `diffTotals`，后者会跳过 hunk 外的文件头。同一行「统计说不算、展开说算」。触发：detail 带 `unifiedDiff` 且无 `presentationMeta`（旧数据/旧 DSH）。
- **`diffShaped` 的注释强于实现**（CT-08）：`tokens.ts:608-626` 的注释承诺「write raw contents 不会 fabricated」，但 `diffShaped` 只按行首字符判断，`"- a\n- b\n+ c"` 被判为 diff-shaped（`style-check.cjs:658` 甚至把它断言成预期）。真正的保护来自「生产路径的 write 行总有 presentationMeta」和「failed 状态隐藏统计」两个外部条件；一旦某条 write 行没有 meta，纯 bullet 文件就会显示假 `+0 -N` 并整块红染。建议把保护写进函数（例如要求 hunk 头或 `@@` 结构）或把注释改成实际情况，并补一条 write-无-meta 回归。
- **hunk 合并差一**（CT-09）：`diffHunks` 的 `index - previous <= 2*context` 少算了一行；实测两处改动隔 6 行时 GNU `diff -U3` 给 1 个 hunk、我们给 2 个。触发条件窄（恰好 6 行），但判据改一行即可对齐（`index - previous - 1 <= 2*context`），并可用 GNU diff 对照写回归。

### CT-10/CT-11（P3）性能结构：常量没接线 + 转换期重复计算

- `CODE_MAX_HEIGHT`（260）与 `TERMINAL_MAX_LINES`（∞）只被 `harness/style-check.cjs:767-768` 读取，渲染器没有任何 `maxHeight`/纵向 `ScrollView`。于是长 read/diff/代码块展开会全量挂载（每行两个 `Text` + 一行 `View`），而 DSH 是 260px 滚动区。`style-check` 断言的是「表里的值」，恰好看不出「值没接线」。
- `parseDiffBlock` 对每个 diff 调 `diffPairRows`（内部 `diffOps` + `diffHunks`）以及 `diffPairBody`（同样两遍），LCS 跑两次；且这些结构卡在 `toolCallData`（transformer 阶段）就构建，与用户是否展开无关。多文件编辑行会把转换成本放大到 2 倍。

## 4. 与 DSH 的保真核验（正面结论）

| 项 | 我们的实现 | DSH 0.2.1-rc.5 的实现 | 结论 |
|---|---|---|---|
| read copy 文本 | `lines.map(text).join("\n")`（`tool-call-data.ts:392`） | `gF` 的 `r.map(text).join("\n")` | 逐字一致 |
| read 折叠 | head=`ceil(8/2)`、tail=`8-head`、windowed=`lines<total` | 同（`gF`，chat `CHAT_READ_MAX_LINES=8`） | 一致 |
| read 行号宽度 | `max(3,digits) * 6.6` | `max(3,digits)ch` | 等价（RN 无 `ch`） |
| search copy 文本 | `[path, ...matches.map("n: line")].join("\n")` 再 `\n\n` | `$F` 同式 | 逐字一致 |
| search shown/total/files | `shown=Σmatches`、`total=meta.total`、`files=files.length` | `SF`/`jF` 同式 | 逐字一致 |
| search 折叠 + tail header 回填 | tail 首行是 match 且 header 不在 head → 用 header 占位、`slice(1)` | `zF` 的 `X`/`de = X===void 0 ? O : O.slice(1)` | 一致 |
| search 空态 | `rows.length===0` → noResults | `p.length===0` → empty | 一致 |
| diff rows/copyText | `+ `/`- `/两空格 context、path/gap 原样 | `kF`/`xF` | 一致 |
| diff 每行着色/左侧 3px 条/8%-12% wash | `tokens.ts:378-427` | DSH 的 inset shadow + 语义色 | 一致（用 RN border 复刻） |
| web fetch | URL + `HTTP n` + truncated | `kU` 同形 | 一致 |
| web search sources | 有序号列 + title/snippet/date + 最多 320px 滚动 | `xU` + `<ol>` + CSS max-height | 一致 |
| terminal 卡片 | command banner + hairline + output | `uF`：command/cwd/exit/signal/copy/maxLines | **不一致，见 CT-02/CT-06** |
| 空白卡防护 | 每个 parser `null` → 回退纯文本 + `hasDetail` | `readCardModel` 等 `null` → generic | 一致（fail-safe） |

## 5. 健康度评分与结论

| 维度 | 分数（1-5） | 理由 |
|---|---|---|
| 正确性 | **3** | 映射与 DSH 的逐字保真度高（read/search/diff copy、计数、折叠），但失败原因丢失、终端丢数据、web 空态判据相反 |
| 健壮性 | **3** | 大量 fail-safe 回退做得干净；但未知 status/detail 的降级方向错（把不知道当成功/空白），且未知行不交还宿主 |
| 可维护性 | **3** | 注释极详尽、多数与实现自洽；但存在注释强于实现（`diffShaped`）、双文案表（`BLOCK_COPY` 与 `locale.ts`）、死契约字段、仅测试读取的常量 |
| 契约一致性 | **3** | `ToolCallData`↔schema 被 harness 钉住；但协议 failed 契约（`error`）不完整、`bodyLabel/name/code/failed` 无消费、`cwd/exitCode` 等 detail 字段被丢弃 |
| 性能 | **3** | 历史行惰性、默认只渲染 8-9 行、shimmer 只跑 active 行；但展开无纵向限高全量渲染、transformer 同步构建结构卡、diff 每文件 LCS 算两遍 |
| 安全 | **5** | 纯展示层：无外部 HTML 注入面（RN `Text` 不解析 HTML）、`Link` 只放行 `http(s)`、`stringifyValue` 兜住循环/BigInt、无凭据或写操作 |
| 测试覆盖 | **3** | 三个离线回归 700 条且与 DSH 源码逐字对照；但错误/未知/渲染层是缺口，且存在「把错误行为断言成预期」与「常量值绿、接线未测」 |

**一句总评**：这是「语义复刻保真度很高、失败与降级面明显不足」的一层实现——正常工具行（read/search/diff/web）跟 DSH 几乎逐字一致，但恰恰在「出错时告诉用户为什么」和「长输出不丢数据」这两件事上留了硬缺口，而且现有全绿回归正好绕过了这两处。

**是否有阻断性健康问题**：**无**。无 P0/P1；工具行仍能正常渲染与展开，问题集中在错误信息、截断与边界降级。

**建议优先级**：

1. **CT-01**（P2）：`ToolCallData` 加独立 error 文本字段 → `toolCall.tsx` 展开区新增错误行 → `index.client.tsx` schema 同步 → 新回归必须能在修复前红（failed write/edit/mcp 三种 + 成功路径无错误块）。
2. **CT-02 + CT-10**（P2/P3）：terminal 卡改为带 `maxHeight` 的纵向滚动并补复制（复用已存在的 `CODE_MAX_HEIGHT`/`copyText`）；若保留 6000 上限，按码点截断并把全量文本给复制。
3. **CT-03 + CT-04**（P3）：未知 detail type 在有 `input/output` 时走 unknown 保底，否则 `return undefined` 交还宿主；status 兜底改保守方向，同步改 `tool-call-check` 的固化断言。
4. **CT-05 + CT-09 + CT-07**（P3）：三个小判据修正（web 空态、hunk 合并差一、legacy diff 文件头），都是一两行 + 一条断言。
5. **CT-06/CT-08/CT-15**（P3）：协议字段补消费（至少 shell cwd + 退出码胶囊、write 空文件状态）、`diffShaped` 与注释对齐。

**未验证项**（不冒充结论）：

- 真机（iOS/Android）上的展示与交互：固定 24/13px 在系统大字体下是否裁剪、横向/纵向滚动手势与 `Pressable` 冲突、compact 布局的观感（本机无模拟器；同类结论见 RENDER-PLAN §4「移动端需要真正的交互门」）。
- 宿主主题实际取值格式（是否 8 位 hex/oklch）；`isLightSurface`/`withAlpha` 的误判在当前默认主题下是否发生。
- `theme.colors` 的引用稳定性对 `buildStyles` `useMemo` 的实际影响（未做渲染计数测量）。
- DSH `TextShimmer`/DSH web 前端的 `linkLabel` 对 IPv6/奇怪 URL 的行为（只核了 `WebBlock`/`ReadBlock`/`SearchBlock`/`TerminalBlock`/`DiffBlock`/`toolRowModel` 的主路径）。
- 未启动真实 daemon、未跑真实模型回合、未截图（本轮为只读审查 + 纯模块复现）。
