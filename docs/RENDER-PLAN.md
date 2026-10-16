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

### Phase 0 · 基础（其他阶段都依赖）
- **服务端**：`#toolResult()` 读 `data.meta` 并透传（typed 分支 + `unknown` 都带上）；
  新增 `detail.meta` 或按块展开成协议字段。
- **服务端**：`web_search` 读 `queries[]`（数组）而不是只读字符串。
- **客户端**：新增共享样式常量模块（字号/行高/圆角/描边/内边距/颜色/折叠行数），
  各块不再各写一套。
- **断言**：`index.client.tsx` 的 zod schema 与 `ToolCallData` 做**键集一致**断言；
  meta 透传断言（构造带 meta 的 `tool/result`，断言 detail 里能读到）。

### Phase 1 · 行头与命令、diff（纯样式，风险最低）
- 行头：固定 24px 单行、无 paddingVertical；摘要**去掉等宽**、13px/24；
  标题与摘要间的 **2×2 圆角方块**；diff 行的 `+A -R` 后缀（11px 等宽）。
- 命令：命令/输出拆成 **banner（cwd 灰 + 命令高对比 + 复制）+ 0.5px 分隔线 + 输出区**；
  输出 11px/18。
- diff：**3px 实色左竖条** + 8%（暗 12%）底色 + `+ `/`- ` 前缀 + 上下文两空格 + 卡头。
- 卡片：`radius 16` + `StyleSheet.hairlineWidth` 描边 + 卡片底色；展开体左缩进 12 → **4**。
- 断言：样式常量快照（防止再漂移）。

### Phase 2 · meta 驱动的块
- **搜索（grep/glob）**：卡头统计「N 处匹配 · M 个文件」+ 复制；按文件分组的粗体路径 + 计数；
  匹配行 `行号: ` 前缀；折叠 **8 行**（头 4 + 「… 其余 N 行」+ 尾 4），同一按钮变「收起」。
  （DSH **不高亮**匹配子串，只弱化行号 —— 照做。）
- **读取**：行号栏（右对齐、灰、不可选中）+ 卡头（lang + 路径）。
- **编辑/写入**：真 hunk diff（`@@`、上下文行）；`write` 的 `create/update` 标注。
- **网页搜索**：有序引用列表（14px 链接 + 13px 摘要 + 日期，320px 就地滚动）。
- **网页抓取**：URL + `HTTP 200` + 截断提示。

### Phase 3 · unknown 分支扩展
- `job_*`、`terminal_*`、`session_*`、`goal_*`、`workflow`、`skill`、`read_image`、
  MCP resources、`str_replace_editor` 等给出 typed detail（结构化展示，而非原始 JSON）。
- 补齐标签/图标表：`skill`、`list_mcp_resources`、`read_mcp_resource`、
  `list_mcp_resource_templates`，以及 DSH 权威表里缺的 7 项
  （`lsp`、`spawn_teammate`、`team_task_*`、`wait_agent`）。

### Phase 4 · 图片、locale、两个漏行
- **图片**：`read_image` / 浏览器截图不再被 `textOf()` 丢掉；先搞清 Paseo 附件通道能否喂图，
  不行就降级为"路径 + 尺寸/字节"的信息行（**失败要响亮**，不静默丢）。
- **locale**：客户端接上 `DSH_PASEO_LANG`（「思考」「计划」「展开/收起」「折叠/收起」等）。
- **compaction**：`consume()` 增加分支，压缩过程可见。
- **worktree_setup**：给 typed detail 或并入 `unknown`，不再出现空行。

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
