# 工具行渲染对齐 DSH · 实施计划

来源：两轮只读调研（DSH 块类型全挖 + 本仓库渲染路径全盘点）。参考产物：
`/tmp/dsh-blocks-2-report.md`（DSH 全部原样 CSS 与数值）、`/tmp/dsh-render-audit/REPORT.md`
（本仓库盘点与差距清单）、[`docs/preview/tool-rows-dsh-vs-proposed.png`](./preview/tool-rows-dsh-vs-proposed.png)（全块对比效果图，HTML 源在 [同名 .html](./preview/tool-rows-dsh-vs-proposed.html)）。

## 0. 决策记录

- 范围：**全部做**（样式层 + meta 透传 + unknown 分支 + 图片 + locale + 压缩行 + 断言）。
- 配色：diff 用 **Paseo 语义色**（`statusSuccess`/`statusDanger`，低饱和），结构对齐 DSH；
  换 DSH 高饱和色只需改一处常量。
- 不做：DSH 的两个既有瑕疵不学 —— 代码块 `lang` 硬编码成 `typescript`、`pre` 的 `sticky` banner。

## 1. 核心事实（决定了工作量）

**我们要的数据早就到了，只是被丢掉。** 桥把 `session/event` 原样转发（含 `data.meta`），
`TimelineBuilder` 手里就有，但 `#toolResult()` 只取 `textOf(message.content)`，**meta 连读都没读**。
本机 25 个真实会话 / 2806 条 `tool/result` 实测：

| 工具 | 带 meta | meta 内容 |
|---|---|---|
| `read` | 291/291 | `lines[{number,text}]`、`totalLines`、`lang` |
| `edit` | 158/175 | `diffs[{path,oldText,newText}]`（hunk 级、带上下文） |
| `write` | 75/82 | `operation:"create"\|"update"`、`diffs[]` |
| `grep` | 7/7 | `shape:"matches"`、`files[{path,matches[{lineNumber,line}]}]`、`total`、`truncated` |
| `glob` | 1/1 | `shape:"paths"`、`paths[]`、`total` |
| `web_search` | 9/9 | `sources[{url,title}]` |
| `web_fetch` | 3/13 | `url`、`statusCode`、`truncated` |
| `read_image` | 31/31 | `path` |
| `bash` | **0/1836** | DSH 的 bash 不声明 `presentationMeta` |

因此搜索分组、读取行号、真 hunk diff、网页卡**都不用改协议**，只需服务端别再丢 meta。

**同时暴露的真问题**（一并修）：
1. `default` 分支吃掉 **49/62** 个工具名（所有 MCP、`job_*`、`terminal_*`、`session_*`、
   `read_image`、`workflow`、`skill`、`goal_*`、MCP resources）。
2. **44 条结果的 image 块被 `textOf()` 静默丢弃**（`read_image` 34、浏览器截图 10）。
3. `web_search` 的 query **永远是空串**（DSH 传 `queries: string[]`，我们只读字符串）。
4. `shell.exitCode` 是死代码（读不存在的 `input.exit_code`；bash 无 `presentationMeta`）。
5. 四个契约字段没人读：`bodyLabel`、`code`、`name`、`phase`。
6. 客户端**完全没接 locale**（「思考」「计划」「展开/收起思考」硬编码中文）。
7. **整个客户端渲染层 + `index.client.tsx` 注册零断言**。
8. `compaction` 被 `consume()` 直接丢弃 → 压缩过程界面不可见。
9. `worktree_setup` 渲染成"只有图标、点开空白"的行。

## 2. 阶段划分（每阶段独立可验收）

### Phase 0 · 基础（其他阶段都依赖）—— 已完成（`d804dd1`）
- **服务端**：`#toolResult()` 读 `data.meta`（DSH 的 `presentationMeta`）并透传（typed 分支 +
  `unknown` 都带上）；落到 **item 级 `metadata.presentationMeta`**（与既有的
  `metadata.description`、`metadata.locale` 合并）。
  **不能放 `detail.meta`**：插件子进程出口会跑 `ProviderEventSchema.parse`，而
  `toolCallDetailSchema` 的每个成员都是 `.strip()`——detail 上的额外字段在过边界时被静默删掉；
  `metadata` 是 `jsonObjectSchema`，原样过去。复现：
  ```bash
  cd paseo-plugin
  node -e 'const {ProviderEventSchema}=require("@getpaseo/plugin/server/provider");
    const item={id:"i",type:"tool_call",callId:"c",name:"read",status:"completed",error:null,
      detail:{type:"read",filePath:"/a",content:"x",meta:{probe:1}},
      metadata:{locale:"zh-CN",presentationMeta:{lines:[{number:1,text:"a"}]}}};
    const p=ProviderEventSchema.parse({type:"timeline.item",sessionId:"s",item});
    console.log(Object.keys(p.item.detail), p.item.metadata);'
  # → [ 'type', 'filePath', 'content' ] { locale: 'zh-CN', presentationMeta: { … } }
  ```
  其余协议字段（`offset`/`filePaths`/`numMatches`/`webResults`/`code`…）照旧填在 detail 上，
  Paseo 的原生行渲染不受影响。
- **服务端**：`web_search` 读 `queries[]`（数组）而不是只读字符串。
- **客户端**：新增共享样式常量模块（字号/行高/圆角/描边/内边距/颜色/折叠行数），
  各块不再各写一套。
- **断言**：`index.client.tsx` 的 zod schema 与 `ToolCallData` 做**键集一致**断言；
  meta 透传断言（构造带 meta 的 `tool/result`，断言 **item 的 `metadata.presentationMeta`**
  里能读到，并用 `ProviderEventSchema.parse` 真跑一遍确认过边界仍在）。

### Phase 1 · 行头与命令、diff（纯样式，风险最低）—— 已完成（`3ca141b`；`5247ef9` 收口数值偏差）
- 行头：固定 24px 单行、无 paddingVertical；摘要**去掉等宽**、13px/24；
  标题与摘要间的 **2×2 圆角方块**；diff 行的 `+A -R` 后缀（11px 等宽）。
- 命令：命令/输出拆成 **banner（命令 + 0.5px 分隔线 + 输出区）**；
  输出 11px/18。（banner 与输出原按 DSH 用全对比前景色，后按用户反馈统一成 muted，
  见文末「刻意的偏离」与 FIELD-NOTES #46。）
- diff：**3px 实色左竖条** + 8%（暗 12%）底色 + `+ `/`- ` 前缀 + 上下文两空格 + 卡头；
  **无行号**（DSH 原样，见文末「DSH 原样、别当成缺口」）。
- 卡片：`radius 16` + `StyleSheet.hairlineWidth` 描边 + 卡片底色；展开体左缩进 12 → **4**。
- 断言：样式常量快照（防止再漂移）。

### Phase 2 · meta 驱动的块 —— 已完成（`bdcc5d1`；`5247ef9` 收口空态文案与数值）
- **数据来源**：一律读 **item 的 `metadata.presentationMeta`**（Phase 0 的 strip 说明；客户端在
  `client/tool-call-data.ts` 里读，服务端在 `server/timeline.ts` 里写）。
- **搜索（grep/glob）**：卡头统计「N 处匹配 · M 个文件」+ 复制；按文件分组的粗体路径 + 计数；
  匹配行 `行号: ` 前缀；折叠 **8 行**（头 4 + 「… 其余 N 行」+ 尾 4），同一按钮变「收起」。
  （DSH **不高亮**匹配子串，只弱化行号 —— 照做。）
- **读取**：行号栏（右对齐、灰、不可选中）+ 卡头（lang + 路径）。
- **编辑/写入**：真 hunk diff（`@@`、上下文行）；`write` 的 `create/update` 标注。
- **网页搜索**：有序引用列表（14px 链接 + 13px 摘要 + 日期，320px 就地滚动）。
- **网页抓取**：URL + `HTTP 200` + 截断提示。

### Phase 3 · unknown 分支扩展 —— 已完成（`3ca141b`；`5247ef9` 补 `run_code` 标签与图标）
- `job_*`、`terminal_*`、`session_*`、`goal_*`、`workflow`、`skill`、`read_image`、
  MCP resources、`str_replace_editor` 等给出 typed detail（结构化展示，而非原始 JSON）。
- 补齐标签/图标表：`skill`、`list_mcp_resources`、`read_mcp_resource`、
  `list_mcp_resource_templates`，以及 DSH 权威表里缺的 7 项
  （`lsp`、`spawn_teammate`、`team_task_*`、`wait_agent`）。

### Phase 4 · 图片、locale、两个漏行
- **Phase 4a · locale / compaction / worktree_setup —— 已完成（`bdcc5d1`）**：
  - **locale**：客户端接上 `DSH_PASEO_LANG`（「思考」「计划」「展开/收起」「折叠/收起」等）。
  - **compaction**：`consume()` 增加分支，把 DSH 的 `compaction/*` 括号映射成 Paseo 原生 marker。
    **一个 `compactionId` 恰好两条 item：`start` 发 `loading`、收尾发**一条** `completed`**。
    宿主的压缩归并函数（从 web bundle 反编译，见 FIELD-NOTES 第 44 条）在收到 `completed`
    时**全表查找第一条 `kind === "compaction" && status === "loading"`** 的行并**原地合并**；
    **找不到 loading 行才会追加新行**。所以压缩期间显示「正在压缩…」，完成后翻转成
    「上下文已手动压缩」，而**第二条 `completed` 会被追加成第二行**——这正是当初三行/两行的
    来源。`summary` 出 `completed`，`end` 只在没有 `summary` 时才补一条。成功的 `/compact`
    命令行整条不发（压缩标记就是它的行，靠 DSH 自己的 `sourceCommandId === commandId`
    关联）；`kind:"error"` 时照旧发 failed 行，因为 marker 承载不了失败。
  - **worktree_setup**：给 typed detail 或并入 `unknown`，不再出现空行。
- **Phase 4b · 图片 —— 已完成**：`read_image` / 浏览器截图不再被 `textOf()` 丢掉。做法走
  **Paseo 既有的形状**，不自造：
  - **桥**（`dsh-bridge/lib/image-host-path.js`）在 `tool/result` 的每个
    `{type:"image", attachment}` 块上**追加** `hostPath` =
    `ctx.get('attachments').imageHostPath(ref)`（`<DSH_HOME>/attachments/v1/objects/<xx>/<sha>`，
    持久副本；`data.meta.path` 是源路径，源文件常已被删）。实时转发、被 hold 的子会话帧、
    `history()` 重放三条路都过一遍；解析不了就原样返回，绝不让事件失败。
  - **插件**（`server/timeline.ts`）为每个带 `hostPath` 的图片块多发一条
    `assistant_message`：`![<alt>](file://<每段 encodeURIComponent 的绝对路径>)`，辅助函数
    逐字照抄宿主 `provider-image-output.js` 的 `encodeFilePath` / `escapeMarkdownImageAlt` /
    `markdownImageSource` / `escapeMarkdownImageSource`。id 稳定为
    `image:<toolCallId>:<块序号>`；没有 `hostPath` 的块**不产生任何行**（回落原文）。
  - **已知行为**：同一份日志重放两次会发出**同一个 id + 同一段文本**，宿主的
    `mapTimelineItem` 把它切成空 delta 后 `return null` —— 即重复被去重丢弃。这是可接受的
    （重复即去重），**不是**把 id 随机化的理由。
  - **证据**：`harness/image-check.cjs`（假桥集成：恰好一条、文本编码、无 hostPath 不出行、
    过 `ProviderEventSchema`、重放重建）、`harness/image-host-path-check.mjs`（纯模块：
    加字段/缺 store/抛错/非 tool-result/history 投影 26 条）、`harness/timeline-check.cjs`
    的图片段。

### Phase 5 · 验收
- 全部 harness（含新增断言）+ `tsc --noEmit` + 宿主编译器产包 + 真机 `archive-registry-check`。
- 重出全块对比图，确认与 `/tmp/all-blocks-preview.html` 的"建议改后"一栏一致。

## 3. 硬性约束（每阶段都适用）

- **不改协议形状**：优先用协议里已有的字段（`filePaths`/`numFiles`/`numMatches`/`truncated`/
  `unifiedDiff`/`code`/`codeText`/`webResults`…）；确需扩展时照 Paseo 适配器的形状来。
- **失败要响亮**：认不出的 meta 形状宁可回落纯文本并记日志，**不要**静默显示空白。
- **改了 `dsh-bridge/` 必须重生成内嵌桥**（`node paseo-plugin/scripts/generate-bridge-assets.mjs`）。
- **RN 妥协项**（已逐条验证，实现时照此）：`white-space: pre` 无等价（横向滚动要包 ScrollView）；
  `box-shadow: inset` → `borderLeftWidth`；`::before` 前缀 → 独立 Text 列；
  `grid`/`sticky`/`color-mix`/`mask`/`:hover` 无解或已有替代。
- 每个阶段结束跑对应 harness；动了服务端必跑 `plugin-check.cjs` 与 `subagent-check.cjs`。

---

## 4. 仍未做 / 已知偏差

这一节是"**别让预览图承诺它交付不了的东西**"的清单。已提交的进度：
`d804dd1`（Phase 0）→ `3ca141b`（Phase 1 + 3）→ `bdcc5d1`（Phase 2 + 4a）→ `5247ef9`
（四处数值偏差 + `run_code` 标签/图标 + 空态文案拆分 + `web_fetch` 图标）。**Phase 4b 已落地**
（图片行、压缩行的 loading→completed、命令行行头的两处重复，见 Phase 4 与 FIELD-NOTES 44/45）。

### 仍未做

- **`run_code` 的 CodeBlock**：标签与图标已在 `5247ef9` 补上（「代码」/`Code`；此前标题
  回落成线名、图标回落成扳手，同属静默降级），但**展开体仍是 `unknown` 的兜底代码面** ——
  没有语言标签、没有复制、没有 `bodyScroll` 限高。决定不学的两条：banner 的
  `position: sticky`（RN 无解）与 `lang` 硬编码 `typescript`（DSH 自己的瑕疵）。
- **MCP / 未知的 ioCard 输入 / 输出两段**：现在是输入（美化 JSON）与输出挤在同一个代码面里；
  DSH 是 `grid-template-columns: max-content 1fr` + 两段各自 `max-height: 150px`。
  Phase 3 只写了"结构化展示，而非原始 JSON"，没点名这个形状 —— 严格说它**计划外**。
- **终端输出**：仍是会折行的 `Text`，不是 `white-space: pre` 的等价物（需要横向
  `ScrollView`）；状态点 / 退出码 pill / 复制键也都还没做。
- **思考行展开体的几何**：缩进 `4px` vs DSH `22px`、字号行高 `14/21` vs `13/24`、正文是纯
  文本而非 Markdown；无预览时 DSH 把 2×2 方块与预览整段 `display: none`，我们仍渲染空预览。
  DSH 展开时行头 **sticky 在 RN 无解**，放弃。
- **`compaction/summary` 的摘要正文没有承载处**：Paseo 的 `compaction` marker 只承载
  `status` / `trigger`（`preTokens` 也刻意不设 —— DSH 的 `shadowedTokenCount` 是另一个量，
  标成"~Nk tokens"就是安静的谎），摘要文本到不了界面。
- **`compaction/prune` 刻意不映射**：它是无模型工具结果剪枝的影子价格、不带
  `compactionId`，它前面的事件是 `tool/result` 替换而不是压缩检查点，DSH 自己的 UI 也不为
  它画标记。
- **read / 代码卡的动作区**：是文字「复制」而非 24×24 图标，且没有换行开关。

### 实现已落地、但断言待补

- **`web_search` 行头图标 = Globe**：`5247ef9` 已经落地 —— `client/tool-call-data.ts` 的
  `WEB_ROW_ICONS`（`web_search: "Globe"` / `web_fetch: "Eye"`）在 detail 分支**之前**判定，
  绕过了"名字级图标只在 detail 缺失或为 `unknown` 时生效"这条规则（`web_search` 的 detail
  是 `search`，grep/glob 继续用放大镜）。**但 `harness/tool-call-check.cjs` 只断言了
  `web_fetch -> Eye`，没有 `web_search -> Globe` 的断言** —— 补一条，否则它会悄悄漂回去。

### 刻意的偏离（DSH 本身没有，不是画错）

- diff 卡的 `@@ -a,b +c,d @@` hunk 头（DSH 只有 `⋯` 分隔）、卡头里的路径与「新建 / 更新」
  标记（DSH 的 CodeToolbar 有 `status` 槽，但 DiffBlock 从不传值）；diff 卡头的语言标签写死成
  `diff`（DSH 用 `languageForPath` 推出 `tsx`），读取卡才用 meta 里的 `lang`。
- MCP 行保留 Paseo 自己的中文名（DSH 是「工具调用 · 工具名」）。
- diff 用 Paseo 语义色（低饱和），不是 DSH 的高饱和 `#22c55e` / `#f25a5a`。
- **非 diff 展开块的正文一律 muted**（命令 banner、输出、读取的代码、搜索命中与文件路径、
  兜底代码面）：DSH 这些行是全对比前景色，但本仓库的思考行与行头标题都是 muted，混在一屏里
  "有的字灰、有的字白"。diff 的 `+`/`-` 语义色是唯一保留的内联格式（FIELD-NOTES #46）。
- **状态色只落在行头图标上**：失败红、编辑完成绿，标签与摘要**恒 muted**。（DSH 是反过来的——
  它让摘要文字变红、图标恒 muted，而且对编辑根本没有成功色。）
  `3ca141b` 对齐 DSH 时把图标固定成了 muted；2026-10-17 与用户确认改回，并确认**只有图标**
  承担状态色：失败和"改完了"要在**扫视**时间线时就能看见，而标签与摘要保持中性，免得整行都在
  喊。实现是 `rowIconColor(colors, status, edit)` 一个判据（`status === "failed"` 先判，
  所以**失败的编辑是红的不是绿的**），运行中的编辑不算绿（还没成功）、取消的不算（既非成功也
  非失败）。
  （第一版客户端 `c18336c` 的图标本来就是 `data.failed ? statusDanger : foregroundMuted`——
  那也是 Paseo 自带行、也就是 opencode 那套的观感。）
  `style-check` 除了断言判据，还**读组件源码断言接线**：光断言辅助函数抓不到"状态色接到了
  另一个 run 上"这类毛病，而上一版正是这么错的。
- **Paseo 自己的 MCP 工具保留细分图标**。Paseo 的 UI 对 `isPaseoToolName` 命中的工具一律画同一个
  品牌标记（`resolveToolCallIconName` → `"paseo"` → `PaseoLogo`，700×700 单路径），**没有任何
  按工具名的图标表**——实测：Paseo 的 58 个工具名在它的前端 bundle 里只出现在"字段顺序/输出字段"
  元数据中，没有一处进图标表。本仓库的 58 条细分图标（浏览器=Globe、终端=SquareTerminal、
  日程=CalendarClock、子代理=Bot…）是**多出来的信息**，所以只在**我们还没有细分图标**时才回落到
  品牌标记（`paseoMark`），而不是回到通用扳手。
  标记取自 Paseo 自己的 web UI bundle（在 daemon 发行包
  `@getpaseo/server/dist/server/web-ui/_expo/static/js/web/index-*.js` 里），路径在浏览器里
  栅格化成 64×64 白底透明 PNG（`client/paseo-mark.ts`），用 `<Image tintColor>` 跟着状态色。
  工具名判定照 Paseo 的 `isPaseoToolName` / `getPaseoToolLeafName` 实现，覆盖
  `mcp__paseo__<t>`、`mcp__paseo_<s>__<t>`、`paseo.<t>`、`paseo_<s>.<t>` 四种写法，以及
  "叶名是 speak 就不算 Paseo 工具"的例外。
  **现状**：18 个 `browser_*` 工具里我们漏了 4 个——`browser_back`、`browser_forward`、
  `browser_hover`、`browser_reload`（Paseo 前端字段表里有，我们的 `PASEO_MCP_ICONS` 没收录）。
  这 4 个就是本标记实际生效的行：它们的 `icon` 仍是 `Wrench`，`paseoMark` 为 true，于是画品牌
  标记而不是扳手。**不要**为了"消灭扳手"把它们补进图标表——补了就再也不会出现品牌标记，而
  这条规则的意思正是"Paseo 的、又只有扳手的，就用 Paseo 的标记"。
  它们的**中英标签**已经补进 `client/locale.ts` 的 `paseoMcpLabels`（否则那一行会把 wire name
  当标题印出来）；**图标仍然故意不补**——标签和图标是两张独立的表，补标签不会让品牌标记消失。
  其余 54 个工具都有细分图标，不受影响。
- **流式期折叠行显示"尾部窗口"，不是 DSH 的段落首行**。DSH 的 ReasoningRow 在运行中取
  `latestCompletedParagraphFirstLine`——要等当前段落的第一个换行出现才换一行，配合它没有揭示动画
  的渲染是够快的。本仓库的折叠行原先读宿主 `useRevealedText` 的揭示副本，两个视图不同源：展开态
  一直读原始 `text`、所以快，折叠行一直滞后。实测同一条 31k 字符推理：展开态按行更新 413 次，
  段落规则只更新 154 次（差 2.7 倍），揭示又在这之上再叠一层延迟。
  现在折叠行读原始 `text`，运行中显示按行宽裁出的**尾部窗口**（随每个到达字符连续左移），流结束
  后切回 DSH 的首行。窗口按 **em 估算宽度**取字（CJK 1em / ASCII 0.55em）：若按字符数算，纯英文
  尾部只填 58%、中英混排 65%，看起来像"这一行变短了"；按宽度算后三种文种都稳定在 95-97%。
  代价：① 不再逐字对应 DSH 的形状 ② 多一个前导 `…`（表示前面还有内容）③ 收尾时从"尾部"跳回
  "首行"——这个跳变 DSH 本来也有，只是幅度小些。
  **退回方法**：把 `client/inline-thinking.tsx` 里那行三元表达式改回
  `reasoningPreview(text, growing)` 即可；`reasoningPreview` 一直保留着 DSH 的规则作兜底
  （首帧没量出行宽时、以及流结束后都用它）。
- **`+A -R` 的两个数字始终着色**（`+` 绿、`-` 红）。**颜色本身与 DSH 一致**——DSH 的
  `.diffAdded` 绿 / `.diffRemoved` 红——但它**只在 hover 或 `aria-expanded=true` 时着色**
  （调研报告 `dsh-blocks-2-report.md` 第 2083 行）。手机上没有 hover，照抄的结果是"永远灰着、
  只有展开才亮"，所以这里始终着色；差别在**时机**，不在配色。
  实现上拆成两个文本 run（一个 run 装不下两种颜色），`-` 那个 run 自带分隔空格，间距与原来的
  单条灰 run 逐像素一致。失败/取消的行仍然不显示它——这条与 DSH 相同（报告第 2084 行）。
- `compaction` 不照抄 DSH 的可展开行形状，跟 Paseo 自己的 marker。

### DSH 原样、别当成缺口

- **命令非零退出码不算失败，行不会变红**。DSH 的 `tool/result` 在该情形下 `isError === false`
  （实测：`ls` 一个不存在的目录 → `isError=false`，输出里带 `[exit code: 2]`），而插件的红色
  判据只有 `message.isError === true` 一条（`server/timeline.ts:916`），所以执行失败的行图标
  与正常行一样是 muted，唯一线索是展开后的 `[exit code: N]`。2026-10-17 与用户确认**不改成
  红**：`grep` 未命中是 1、`diff` 有差异是 1、`test` 判断是 1，这些"非零但正常"的退出码很常见，
  一律标红就是噪音。要改的话应当用警告色而不是危险色，并且要记成刻意的偏离。
- **diff 卡没有行号**（`edit` / `write` 的展开体）。这不是漏做：本机
  `@deepseek-ai/dsh@0.2.0-rc.2` 的 `dsh-web-frontend` 里，diff 的行只有
  `path / del / add / context / gap` 五种，渲染是
  `jsx("div", { className: ue(line, kind), children: text })` —— **一层文本**，没有第二个
  `<span>`；它的 CSS 模块（`17vb8`）类表是 `block · body · line · path · gap · del · add ·
  context · expand`，**没有 `lineNumber` / `gutter`**，`.body` 还是
  `grid-template-columns: minmax(max-content,1fr)` 的单列，`+ `/`- `/两空格全部来自
  `::before{content}`。行号在 DSH 里只属于另外三处：读取（`_gutter_1ay0u_7` + 变量
  `--dsl-read-gutter`）、搜索（`_lineNumber_1u3n2_60`）、代码块（`_numbered_7gxqk_122`）。
  我们照抄：数字列只出现在 `readGutterTextStyle` 与 `searchLineNumberTextStyle`；
  "这是文件的哪一段"由我们多出来的 `@@ -a,b +c,d @@` 头回答。2026-10-17 与用户确认过，
  **保持无行号**（加行号 = 再记一条刻意偏离，数据层已具备：`DiffHunk.oldStart/newStart`）。
