# 工具行标签 / 图标覆盖盘点

> 2026-10-20，分支 `fix/tool-label-coverage`（从 main `10c3fb8` 切出）。
> 起因：用户手机截图里工具行仍在印 wire name（`memory_search · {"query":…}`）并配兜底扳手。
> 本文记录**怎么取的真实调用集**、**补前补后的缺口清单**、**补了什么**，以及**以后怎么复跑**。

## 1. 数据来源

因为离线 harness 不能读本机 `~/.dsh/sessions`（机器相关、慢、且 CI 没有这些文件），
采集是一次性的，快照以清单形式写进 `harness/locale-check.cjs`；本文是可复验的采集记录。

### 1.1 真实调用集（真的被调用过）

```bash
# 会话日志是多帧 zstd：zstd -dc 才能解全部帧（zlib.zstdDecompressSync 只解第一帧）
find ~/.dsh/sessions -name "session.v4.jsonl.zstd" -print0 \
  | xargs -0 -P 8 -n 16 zstd -dc 2>/dev/null \
  | python3 -c '读每行，只取 {"type":"tool/call","data":{"name":…}}，统计频次'
```

结果（2026-10-20）：**655 个会话文件、25,237 条 `tool/call`、96 个不同工具名**。
这是"实际发生过"的下界。

### 1.2 可能调用集（模型被允许调用的全集）

模型只能调 `request/header` 里声明的工具，所以同一批日志里的 `request/header` 就是
"可能调用集"，比扫 `tool/call` 更完整、也不需要 `node harness/tools.mjs` 那种真模型回合：

```bash
# 每条 request/header 的 data.header.tools[].name
find ~/.dsh/sessions -name "session.v4.jsonl.zstd" -print0 \
  | xargs -0 -P 8 -n 16 zstd -dc 2>/dev/null \
  | python3 -c '读每行，只取 {"type":"request/header","data":{"header":{"tools":[…]}}}，收集 name'
```

结果：**855 条 `request/header`、161 个不同工具名**；真实调用集（除下面那个臆造名）是它的子集。
两者合并 = 162 个名字（161 catalog + 1 个模型臆造名）。

其中"本仓库该管"的 136 个：DSH 原生工具、agent-team 工具、`dsh-prime-memory` 的记忆工具、
桥自身工具（`archive_subagents`）、`mcp__paseo__*` 的 Paseo MCP 工具。
另 25 个是另一个插件的 MCP server（`mcp__server_browser__*`），按仓库既有约定保留 wire name
（见 `harness/tool-call-check.cjs` 的 `mcp__github__create_issue` 用例），不算缺口。

### 1.3 现状 diff 方法

把两张表编译成 CJS（与 harness 相同的 `node16` 编译），对每个名字跑：
- `toolLabel(name)`（zh / en 各一次）——等于 wire name 即缺标签；
- `toolIcon(name, 代表性 detail)`——`Wrench` 即缺图标。代表性 detail 必须按
  `server/timeline.ts` 的 `toolDetail()` 给：`shell`/`read`/`edit`/`write`/`search`/`fetch`/
  `plain_text`/`plan`/`sub_agent`，其余都是 `unknown`。**踩过的坑**：`todo_write` /
  `ask_user_question` 是 `plain_text` 且带 `icon: "sparkles"`，若代表性 detail 只写
  `{type:"plain_text"}` 会把它们误报成缺图标。

## 2. 补前 → 补后

| 项 | 补前 | 补后 |
|----|------|------|
| 本仓库该管的挂载工具（136） | 21 个**双语标签和图标都缺**（21/136 匿名） | 0 个匿名 |
| 只有标签、没有图标 | 0 | 0 |
| 只有图标、没有标签 | 0 | 0 |
| 记忆家族图标重复 | —（19 个全缺） | 19 个工具 19 个互不相同的 glyph |
| 外来 MCP server（`mcp__server_browser__*`，25） | wire name | wire name（有意，断言保留） |
| 模型臆造名（1） | wire name | wire name（有意，断言保留） |

补前的 21 个缺口（全部"双语标签 + 图标都缺"）：

`conversation_search`、`memory_search`、`memory_search_graph`、`memory_expand_graph_node`、
`memory_add`、`memory_import`、`memory_delete`、`memory_conflicts`、`memory_conflicts_rejected`、
`memory_resolve_conflict`、`memory_receipts`、`memory_read_scene`、`memory_room_admin`、
`memory_room_review`、`memory_ruminate`、`memory_ruminate_cancel`、`memory_ruminate_status`、
`memory_slot_list`、`memory_slot_write`、`memory_slot_close`、`working_directory`。

另有两个任务卡里点名、但**经实读确认已经覆盖**的（不在缺口内）：
`archive_subagents`（`locale.ts` 中英 + `tool-call-data.ts` 图标表 `Archive`）、
`terminal_send`（`Send terminal input` / `发送终端输入` / `SquareTerminal`）。

## 3. 新增条目

来源：`dsh-prime-memory`（`~/.dsh/profiles/paseo/node_modules/dsh-prime-memory/dist/tools/index.js`
与 `tools/slots.js`/`tools/skills.js`）、DSH 的 `dsh-tool-working-directory/lib/index.js`；
每个名字也都出现在本机真实的 `request/header` 里。图标名均已用
`grep -o ',"<Name>",{enumerable:!0,get:' <web-ui>/index-*.js` 在宿主 bundle 的
lucide-react 导出表里核验存在。

| 工具名 | 中文 | English | 图标 |
|--------|------|---------|------|
| `memory_search` | 搜索记忆 | Search memory | `SearchCheck` |
| `memory_search_graph` | 搜索记忆图谱 | Search memory graph | `Network` |
| `memory_expand_graph_node` | 展开图谱节点 | Expand graph node | `Waypoints` |
| `memory_add` | 添加记忆 | Add memory | `Plus` |
| `memory_import` | 导入记忆 | Import memory | `Import` |
| `memory_delete` | 删除记忆 | Delete memory | `Trash2` |
| `memory_conflicts` | 列出记忆冲突 | List memory conflicts | `Scale` |
| `memory_conflicts_rejected` | 列出被丢弃的冲突决策 | List rejected conflict decisions | `FileX2` |
| `memory_resolve_conflict` | 裁决记忆冲突 | Resolve memory conflict | `Gavel` |
| `memory_receipts` | 查看记忆决策凭证 | Read memory receipts | `ReceiptText` |
| `memory_read_scene` | 读取记忆场景 | Read memory scene | `BookOpenText` |
| `memory_room_admin` | 管理记忆分类 | Manage memory rooms | `LayoutGrid` |
| `memory_room_review` | 复查孤立记忆 | Review orphan memories | `ClipboardList` |
| `memory_ruminate` | 触发记忆反刍 | Run memory distillation | `RefreshCw` |
| `memory_ruminate_cancel` | 取消记忆反刍 | Cancel memory distillation | `CircleStop` |
| `memory_ruminate_status` | 查看反刍状态 | Check distillation status | `Gauge` |
| `memory_slot_list` | 列出记忆槽位 | List memory slots | `List` |
| `memory_slot_write` | 写入记忆槽位 | Write memory slot | `PenLine` |
| `memory_slot_close` | 关闭记忆槽位 | Close memory slot | `PackageCheck` |
| `conversation_search` | 搜索对话记录 | Search conversations | `MessagesSquare` |
| `working_directory` | 查看或切换工作目录 | Show or change working directory | `FolderTree` |

写范围：`paseo-plugin/client/locale.ts`（中英各 21 条）、`paseo-plugin/client/tool-call-data.ts`
（21 个图标），只加表项、不改逻辑。

### 3.1 有意不覆盖的

- **`mcp__server_browser__*`（25 个）**：Server Browser 插件的 MCP server，不属于本仓库/DSH/Paseo
  任何一方的 catalog。本仓库对"别的 MCP server"的既定行为是保留 wire name（另一处证据：
  `mcp__github__create_issue` 的 harness 断言）。给它们补表等于替另一个插件的工具集押版本。
- **`mcp__paseo__mcp_list_tools`（1 次真实记录）**：模型臆造名。`request/header` 里只有
  `mcp_list_tools`；该调用结果是 `Error: unknown tool "mcp__paseo__mcp_list_tools"`
  （`ToolNotFoundError`，会话 `b9a2b365-…` seq 4560/4561）。给不存在的工具补标签会把一次失败的
  调用伪装成正常行，故不补，并在 harness 里断言它保持 wire name + 扳手。
- **`memory_skill_*`（4 个：list/read/pin/archive）**：`dsh-prime-memory` 声明了它们，但当前
  profile 是 `skillsEnabled: false`，实测任何 `request/header` 都没有它们（未挂载）。
  一旦打开"技能结晶"就会以 wire name 出现，届时应连同它们一起补表；本次不凭声明而凭挂载证据。

## 4. 断言（核心验收点）

`harness/locale-check.cjs` 新增一节
**"the tools this machine has really been offered are never anonymous"**：把 136 个"本仓库该管"的
挂载工具名作为快照写进 harness（离线、不依赖本机 sessions），逐个断言：
双语标签存在且不是 wire name、图标不是 `Wrench`、英中列不是互相复制；
再断言 19 个记忆工具图标两两不同；外来 server 的 25 个名字与 1 个臆造名保持 wire name。

运行（from `paseo-plugin`，编译产物用独立目录，跑完删）：

```bash
npx tsc client/locale.ts client/tool-call-data.ts \
  --outDir .dbg-lc --rootDir . --module node16 --moduleResolution node16 \
  --target ES2022 --skipLibCheck
echo '{"type":"commonjs"}' > .dbg-lc/package.json
cp ../harness/locale-check.cjs .dbg-lc/
cd .dbg-lc && node locale-check.cjs
```

结果（2026-10-20）：`235 passed, 0 failed`；`npx tsc --noEmit` 干净；
`harness/tool-call-check.cjs` `335 passed, 0 failed`。

变异验证（证明断言真的钉住东西，不是绿灯摆设）：

| 变异 | 结果 | 还原后 |
|------|------|--------|
| 删掉 `memory_search` 的中英标签 | `FAIL every mounted tool has a label in both languages — got ["memory_search (en)","memory_search (zh-CN)"]` 等 3 条，`232 passed, 3 failed` | `235 passed, 0 failed` |
| 删掉 `memory_search` 的图标 | `FAIL every mounted tool draws its own glyph (none falls to the wrench) — got ["memory_search: Wrench"]`，`234 passed, 1 failed` | `235 passed, 0 failed` |

## 5. 以后怎么复跑（上游/版本变了时）

1. 重跑 §1.2 的采集命令，得到新的挂载 catalog；
2. 与 `harness/locale-check.cjs` 里的 `MOUNTED_TOOLS` / `FOREIGN_SERVER_TOOLS` 名单对比，
   新增的名字按 §1.3 的方法判断缺哪一半；
3. 补 `locale.ts`（中英）与 `tool-call-data.ts`（图标：先在宿主 bundle 里 grep 确认 lucide 名存在，
   再确认不与同家族重复）；
4. 更新 harness 里的名单与两个计数（153 / 25）以及本文 §2/§3 的表格。

> 注：快照是**机器/版本相关**的。它故意写死计数，所以上游增删工具时 harness 会报红，
> 提醒你重新采集而不是假装没变化。

## 6. 2026-11-07：17 个工具行补齐（标签 / 图标 / L2）

### 6.1 缺口

上一轮（§2）之后新增或漏掉的 17 个工具，仍以 wire name + 扳手出现在时间流：

`memory_update`、`memory_migrate_relation`、`memory_reproject`、`plugin_manager`、
`remote_create_session`、`remote_download_file`、`remote_get_operation`、
`remote_interrupt_session`、`remote_list_hosts`、`remote_list_sessions`、
`remote_list_workspaces`、`remote_read_session`、`remote_send_message`、
`remote_upload_file`、`remote_wait_sessions`、`schedule_edit`、`schedule_view`。

`harness/locale-check.cjs` 的 `MOUNTED_TOOLS` 快照 136 → **153**；memory 家族 19 → **22**
（新增三个写工具，图标两两不同）。

### 6.2 来源（逐个工具的 schema 依据）

- `memory_update` / `memory_reproject` / `memory_migrate_relation`：
  `~/.dsh/profiles/paseo/node_modules/dsh-prime-memory/dist/tools/index.js` —
  输出 schema 分别为 `memory_update` :984 `{id, retired_id, notice}`、`memory_reproject` :1185
  `{queued, job_ids, skipped_ids, notice}`、`memory_migrate_relation` :1247
  `{carrier_id, edge_ids, closed_edge_ids, queued, notice}`。**但 Paseo 只拿得到 render 的
  默认中文句**（memory 工具没有 `presentationMeta`，`detail.output` 是 `message.content` 文本）：
  `memory_update` :1004-1006 `已修订记忆,新版本 <id>(旧版 <retired_id> 已退场可恢复)`；
  `memory_reproject` :1207-1213 `已入队 <queued> 个重投作业` /
  `已入队 <queued> 个重投作业(跳过不存在 <n> 条)`；`memory_migrate_relation` :1275-1282
  `关系已迁移:<closed> 条旧边闭合,<edge> 条新边 active;源记录 <carrier_id>`。
  L2 按这些默认句严格整句匹配（允许首尾空白），notice / 自定义句 / 任何不匹配一律回落 L1。
- `plugin_manager`：`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:75`
  —— 输出是 JSON 字符串；`list_*` 返回 `{entries, total, nextOffset}`（L2 把 entries **逐项**
  作为可见条目、顺序不变、整对象显示，`copyText` 保留完整原始 JSON），`set/install/remove/
  set_version_exemption` 返回 `withNextStep` 的 `{application, ...}` 结果；`list_version_exemptions`
  按记录自身键拆条目并保留完整 `copyText`。
- `schedule_edit` / `schedule_view`：
  `~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-schedule/lib/index.js:594` / `:611`；
  `TASK_SCHEMA` :137、`VIEW_OUTPUT_SCHEMA` :364、`EDIT_OUTPUT_SCHEMA` :369、`renderValue` :406
  （输出一律 `JSON.stringify` 字符串；`delete` → `{id, deleted: true}`，view → task 或
  `{id, code:"schedule_not_found"}`）。
- `remote_*`（11 个）：本机真实 `request/header`（会话 `ad42f205-d676-4a21-8674-40885f9152b8`
  seq 17，87 个工具）带有这 11 个工具的完整 `name` / `description` / `parameters`；扫描
  本机 1996 个 `session.v4.jsonl.zstd` 中没有任何 `tool/call` 使用它们（0 次调用），所以没有
  输出样本。L2 只做输入侧 + `description` 明示的 receipt 字段（`sessionId`、`localPath`+
  `bytes`、`path`+`bytes`、`accepted`、`operationId`），其余结果留给 L1，不猜列表/历史形状。

### 6.3 图标（均已在宿主 web bundle 的 lucide-react 导出表核验）

核验命令（同 §3）：`grep -o ',"<Name>",{enumerable:!0,get:' <web-ui>/index-*.js`。

| 工具名 | 中文 | English | 图标 |
|--------|------|---------|------|
| `memory_update` | 修订记忆 | Update memory | `FilePenLine` |
| `memory_migrate_relation` | 迁移记忆关系 | Migrate memory relation | `ArrowRightLeft` |
| `memory_reproject` | 重建记忆投影 | Rebuild memory projection | `RefreshCcw` |
| `plugin_manager` | 管理插件 | Manage plugins | `Puzzle` |
| `schedule_edit` | 修改定时任务 | Edit scheduled task | `CalendarCog` |
| `schedule_view` | 查看定时任务详情 | View scheduled task | `CalendarSearch` |
| `remote_list_hosts` | 列出远程主机 | List remote hosts | `Cloud` |
| `remote_list_workspaces` | 列出远程工作区 | List remote workspaces | `Folders` |
| `remote_list_sessions` | 列出远程会话 | List remote sessions | `ListTree` |
| `remote_read_session` | 读取远程会话 | Read remote session | `FileSearch` |
| `remote_create_session` | 创建远程会话 | Create remote session | `MessageSquarePlus` |
| `remote_send_message` | 发送远程消息 | Send remote message | `Send` |
| `remote_interrupt_session` | 中断远程会话 | Interrupt remote session | `Ban` |
| `remote_wait_sessions` | 等待远程会话 | Wait for remote sessions | `Clock` |
| `remote_download_file` | 下载远程文件 | Download remote file | `Download` |
| `remote_upload_file` | 上传远程文件 | Upload remote file | `Upload` |
| `remote_get_operation` | 查看远程操作回执 | Read remote operation | `FileCheck` |

### 6.4 断言与检查（2026-11-07 实跑）

| 检查 | 结果 |
|------|------|
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 |
| `harness/locale-check.cjs`（plugin-build 目录） | **762 passed / 0 failed**（原 706；MOUNTED_TOOLS 153、memory 22） |
| `harness/tool-call-check.cjs`（plugin-build 目录） | **732 passed / 0 failed**（原 603；17 个 mapper 各有正常 + 形状不符断言；memory 成功卡 body 清空、copyText 保留原句） |

### 6.5 未覆盖 / 未验证

1. `remote_list_hosts` / `remote_list_workspaces` / `remote_list_sessions` / `remote_read_session`
   / `remote_wait_sessions` 只做输入侧行头与参数，不解析列表/历史/等待结果（无实据）。
2. `remote_get_operation` 只在输出对象含 `operationId` 时出卡，其余回落 L1。
3. `memory_*` 的 L2 已按真实 `render` 默认中文句（而非 JSON 对象）解析；`notice`、自定义句与
   非匹配形状回落 L1。仍未做真机回合验证（任务禁止重启 daemon / 跑真实模型回合）。
4. 未做真机 UI 验证（任务禁止重启 daemon / 跑真实模型回合）。
